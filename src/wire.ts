import dnsPacket = require('dns-packet');
import { LabError } from './errors';
import { normalizeName } from './names';

export interface Question { name: string; type: string; class: string }
export interface SoaData { mname: string; rname: string; serial: number; refresh: number; retry: number; expire: number; minimum: number }
export interface RecordData { name: string; type: string; class: string; ttl: number; data: string | SoaData }
export interface Packet {
  id: number;
  type: 'query' | 'response';
  flags: number;
  questions: Question[];
  answers: RecordData[];
  authorities: RecordData[];
  additionals: RecordData[];
}
export interface Parsed { packet: Packet; flags: number }

// The adapter describes the runtime codec surface, including its name primitive.
// All untrusted framing is checked before the full codec sees a packet.
const codec = dnsPacket as unknown as {
  encode(input: Partial<Packet>): Buffer;
  decode(input: Buffer): Packet;
  name: { decode: ((input: Buffer, offset: number) => string) & { bytes: number } };
};
export function encode(input: Partial<Packet>): Buffer { return codec.encode(input); }

function bad(message: string): never { throw new LabError('DecodeError', message); }

export function decodeStrict(bytes: Buffer, limit = 16384, allowTruncatedUdpBody = false): Parsed {
  if (bytes.length < 12 || bytes.length > limit) bad('DNS message size out of bounds');
  const qd = bytes.readUInt16BE(4);
  const counts = [bytes.readUInt16BE(6), bytes.readUInt16BE(8), bytes.readUInt16BE(10)];
  if (qd !== 1 || counts.reduce((a, b) => a + b, 0) > 32) bad('Question or record count out of bounds');
  const boundaries = new Set<number>();
  const need = (at: number, size: number, end = bytes.length): void => {
    if (at < 0 || at + size > end) bad('Incomplete field');
  };
  const nameAt = (start: number, physicalEnd = bytes.length, allowRoot = false): number => {
    let cursor = start;
    let end = -1;
    let jumps = 0;
    let expanded = 1;
    let labels = 0;
    const visited = new Set<number>();
    while (true) {
      const bound = end < 0 ? physicalEnd : bytes.length;
      need(cursor, 1, bound);
      if (visited.has(cursor)) bad('Compression cycle');
      visited.add(cursor);
      const length = bytes[cursor]!;
      if ((length & 0xc0) === 0xc0) {
        need(cursor, 2, bound);
        const target = ((length & 0x3f) << 8) | bytes[cursor + 1]!;
        if (target >= cursor || !boundaries.has(target) || ++jumps > 16) bad('Invalid or excessive compression');
        boundaries.add(cursor);
        if (end < 0) end = cursor + 2;
        cursor = target;
        continue;
      }
      if ((length & 0xc0) !== 0) bad('Unsupported label encoding');
      boundaries.add(cursor);
      if (length === 0) {
        if (end < 0) end = cursor + 1;
        break;
      }
      need(cursor + 1, length, bound);
      // Validate label bytes before the codec joins labels with dots or applies
      // UTF-8 decoding. Otherwise a literal dot can forge a different label layout.
      for (let index = 0; index < length; index++) {
        const byte = bytes[cursor + 1 + index]!;
        const alphanumeric = (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);
        if (!alphanumeric && !(byte === 0x2d && index > 0 && index < length - 1)) bad('Invalid hostname label bytes');
      }
      expanded += length + 1;
      if (expanded > 255 || ++labels > 127) bad('Expanded name exceeds bounds');
      cursor += length + 1;
    }
    try {
      const text = codec.name.decode(bytes, start);
      if (codec.name.decode.bytes !== end - start) bad('Name extent disagreement');
      normalizeName(text, allowRoot);
    } catch (error) {
      if (error instanceof LabError && error.code === 'DecodeError') throw error;
      bad('Invalid encoded hostname');
    }
    return end;
  };
  let cursor = nameAt(12);
  need(cursor, 4);
  cursor += 4;
  if (allowTruncatedUdpBody && (bytes.readUInt16BE(2) & 0x0200) !== 0) {
    // A matched UDP TC response can end inside an RR. Decode only the complete
    // question, retaining the original flags; no answer bytes are interpreted.
    const questionOnly = Buffer.from(bytes.subarray(0, cursor));
    questionOnly.fill(0, 6, 12);
    try {
      return { packet: codec.decode(questionOnly), flags: bytes.readUInt16BE(2) };
    } catch {
      return bad('Codec rejected truncated response question');
    }
  }
  for (const count of counts) {
    for (let index = 0; index < count; index++) {
      cursor = nameAt(cursor, bytes.length, true);
      need(cursor, 10);
      const type = bytes.readUInt16BE(cursor);
      const cls = bytes.readUInt16BE(cursor + 2);
      const size = bytes.readUInt16BE(cursor + 8);
      const start = cursor + 10;
      const end = start + size;
      need(start, size);
      if (cls !== 1 || ![1, 28, 6].includes(type)) {
        throw new LabError('ProtocolError', 'Unsupported record type or class');
      }
      if ((type === 1 && size !== 4) || (type === 28 && size !== 16)) bad('Address RDLENGTH mismatch');
      if (type === 6) {
        let soa = nameAt(start, end, true);
        soa = nameAt(soa, end, true);
        if (soa + 20 !== end) bad('SOA RDLENGTH mismatch');
      }
      cursor = end;
    }
  }
  if (cursor !== bytes.length) bad('Trailing bytes after DNS message');
  try {
    return { packet: codec.decode(bytes), flags: bytes.readUInt16BE(2) };
  } catch {
    return bad('Codec rejected structurally checked message');
  }
}

export function questionMatches(parsed: Parsed, id: number, expected: Question): boolean {
  const p = parsed.packet;
  const q = p.questions[0];
  return p.id === id && !!q && normalizeName(q.name) === expected.name && q.type === expected.type && q.class === 'IN';
}

export function checkResponseFlags(parsed: Parsed, tcp: boolean): boolean {
  const flags = parsed.flags;
  const allowed = 0x8000 | 0x0400 | 0x0200 | 0x0100 | 0x000f;
  if (!(flags & 0x8000) || !(flags & 0x0400) || (flags & ~allowed) !== 0 || ![0, 3].includes(flags & 15)) {
    throw new LabError('ProtocolError', 'Expected an authoritative standard NOERROR or NXDOMAIN response');
  }
  const truncated = (flags & 0x0200) !== 0;
  if (tcp && truncated) throw new LabError('ProtocolError', 'Truncated TCP response');
  return truncated;
}
