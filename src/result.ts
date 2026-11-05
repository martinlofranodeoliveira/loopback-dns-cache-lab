import { isIP } from 'node:net';
import { LabError } from './errors';
import { isAncestor, normalizeName, QueryType } from './names';
import { Parsed, SoaData } from './wire';

export interface QueryResult {
  name: string;
  type: QueryType;
  class: 'IN';
  status: 'positive' | 'NXDOMAIN' | 'NODATA';
  addresses: string[];
  ttlSeconds: number;
  fromCache: boolean;
  transport: 'udp' | 'tcp' | 'cache';
}

function labelCount(owner: string): number {
  const normalized = normalizeName(owner, true);
  return normalized ? normalized.split('.').length : 0;
}

export function interpret(parsed: Parsed, name: string, type: QueryType, transport: 'udp' | 'tcp'): QueryResult {
  const { packet, flags } = parsed;
  if (packet.additionals.length !== 0) throw new LabError('ProtocolError', 'Additional records are outside the lab subset');
  for (const record of packet.answers) {
    if (record.class !== 'IN' || record.type !== type || normalizeName(record.name, true) !== name || typeof record.data !== 'string') {
      throw new LabError('ProtocolError', 'Unsupported answer owner or RRset');
    }
  }
  for (const record of packet.authorities) {
    if (record.class !== 'IN' || record.type !== 'SOA') throw new LabError('ProtocolError', 'Referrals are not supported');
  }
  const result: QueryResult = { name, type, class: 'IN', status: 'NODATA', addresses: [], ttlSeconds: 0, fromCache: false, transport };
  if (packet.answers.length) {
    if ((flags & 15) !== 0) throw new LabError('ProtocolError', 'NXDOMAIN cannot contain a supported answer');
    result.status = 'positive';
    result.ttlSeconds = Math.min(...packet.answers.map(r => r.ttl));
    result.addresses = packet.answers.map(r => {
      const address = r.data as string;
      if (isIP(address) !== (type === 'A' ? 4 : 6)) throw new LabError('DecodeError', 'Invalid address data');
      return type === 'A' ? address : new URL(`http://[${address}]/`).hostname.slice(1, -1);
    });
    return result;
  }
  result.status = (flags & 15) === 3 ? 'NXDOMAIN' : 'NODATA';
  const candidates = packet.authorities.filter(r => isAncestor(normalizeName(r.name, true), name));
  candidates.sort((a, b) => labelCount(b.name) - labelCount(a.name));
  const soa = candidates[0];
  if (soa) result.ttlSeconds = Math.min(soa.ttl, (soa.data as SoaData).minimum);
  return result;
}

export function detached(result: QueryResult): QueryResult {
  return { ...result, addresses: [...result.addresses] };
}
