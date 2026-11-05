import * as dgram from 'node:dgram';
import * as net from 'node:net';
import { decodeStrict, encode, Packet, RecordData } from '../src/wire';
import { Scenario, scenario, send, serve } from './protocol';

const malformed = Buffer.from('1234840000010001000000000161076578616d706c6504746573740000010001c00c00010001000000020003c0000208', 'hex');
// Independent wire fixture: TC=1, complete question, but only two of the four
// declared A-data bytes remain. Its body must be discarded before TCP retry.
const partialTc = Buffer.from('1234860000010001000000000161076578616d706c6504746573740000010001c00c00010001000000020004c000', 'hex');
let config: Scenario = { mode: 'positive' };
let udp: dgram.Socket;
let tcp: net.Server;
const connections = new Set<net.Socket>();
const timers = new Set<NodeJS.Timeout>();
const held: (() => void)[] = [];
let stopping = false;
const counts = { udp: 0, tcp: 0, answers: 0 };

function later(fn: () => void, ms: number): void {
  const timer = setTimeout(() => { timers.delete(timer); if (!stopping) fn(); }, ms);
  timers.add(timer);
}
function answer(query: Packet, cfg: Scenario, overTcp: boolean): Buffer {
  const q = query.questions[0]!;
  const soa: RecordData = { name: 'example.test', type: 'SOA', class: 'IN', ttl: 60, data: {
    mname: 'ns.example.test', rname: 'hostmaster.example.test', serial: 1, refresh: 60, retry: 30, expire: 300, minimum: 3
  } };
  const base: Partial<Packet> = { id: query.id, type: 'response', flags: 0x0400, questions: query.questions, answers: [], authorities: [], additionals: [] };
  if (cfg.mode === 'malformed') { const b = Buffer.from(malformed); b.writeUInt16BE(query.id); return b; }
  if (!overTcp && cfg.mode === 'partial-tc') { const b = Buffer.from(partialTc); b.writeUInt16BE(query.id); return b; }
  if ((!overTcp && ['truncated', 'tcp-keepalive', 'tcp-fragment', 'tcp-eof', 'tcp-oversize', 'tcp-zero', 'tcp-tc', 'tcp-trailing'].includes(cfg.mode)) || (overTcp && cfg.mode === 'tcp-tc')) {
    return encode({ ...base, flags: 0x0600 });
  }
  if (['nxdomain', 'no-soa', 'spoof-soa'].includes(cfg.mode)) {
    base.flags = 0x0403;
    base.authorities = cfg.mode === 'no-soa' ? [] : [soa];
  } else if (cfg.mode === 'dual' && q.type === 'A') {
    base.authorities = [soa];
  } else {
    base.answers = [{ name: q.name, type: q.type, class: 'IN', ttl: cfg.ttl ?? 2, data: q.type === 'A' ? '192.0.2.8' : '::1' }];
  }
  return encode(base);
}
function readQuery(bytes: Buffer): Packet {
  const p = decodeStrict(bytes, 4096);
  if (p.flags !== 0 || p.packet.type !== 'query' || !['A', 'AAAA'].includes(p.packet.questions[0]!.type) || p.packet.questions[0]!.class !== 'IN' || p.packet.answers.length || p.packet.authorities.length || p.packet.additionals.length) throw new Error('Invalid lab query');
  return p.packet;
}
function schedule(cfg: Scenario, action: () => void): void {
  if (cfg.mode === 'silent') return;
  if (cfg.hold) { if (held.length < 8) held.push(action); return; }
  action();
}
function handleUdp(bytes: Buffer, source: dgram.RemoteInfo): void {
  if (source.address !== '127.0.0.1' || stopping) return;
  try {
    const query = readQuery(bytes);
    const cfg = { ...config };
    counts.udp++;
    const response = answer(query, cfg, false);
    schedule(cfg, () => {
      if (stopping) return;
      const transmit = (b: Buffer): void => { counts.answers++; udp.send(b, source.port, '127.0.0.1', () => undefined); };
      if (cfg.mode === 'wrong-id' || cfg.mode === 'flood') {
        const wrong = Buffer.from(response);
        wrong.writeUInt16BE((query.id + 1) & 0xffff);
        for (let i = 0; i < (cfg.mode === 'flood' ? 9 : 1); i++) transmit(wrong);
        if (cfg.mode === 'wrong-id') later(() => transmit(response), 5);
      } else transmit(response);
    });
  } catch { /* Invalid client traffic has no response in this private lab. */ }
}
function handleTcp(socket: net.Socket): void {
  if (connections.size >= 8 || socket.remoteAddress !== '127.0.0.1') { socket.destroy(); return; }
  connections.add(socket);
  socket.on('close', () => connections.delete(socket));
  socket.on('error', () => socket.destroy());
  socket.setTimeout(2000, () => socket.destroy());
  let bytes = Buffer.alloc(0);
  let handled = false;
  socket.on('data', chunk => {
    if (handled) { socket.destroy(); return; }
    if (bytes.length + chunk.length > 4098) { socket.destroy(); return; }
    bytes = Buffer.concat([bytes, chunk]);
    if (bytes.length < 2) return;
    const length = bytes.readUInt16BE(0);
    if (length < 12 || length > 4096 || bytes.length > length + 2) { socket.destroy(); return; }
    if (bytes.length !== length + 2) return;
    handled = true;
    try {
      const query = readQuery(bytes.subarray(2));
      const cfg = { ...config };
      counts.tcp++;
      const response = answer(query, cfg, true);
      schedule(cfg, () => {
        if (stopping || socket.destroyed) return;
        counts.answers++;
        const prefix = Buffer.alloc(2);
        prefix.writeUInt16BE(response.length);
        const frame = Buffer.concat([prefix, response]);
        if (cfg.mode === 'tcp-eof') { socket.end(frame.subarray(0, 5)); return; }
        if (cfg.mode === 'tcp-oversize') { socket.end(Buffer.from([0x40, 0x01])); return; }
        if (cfg.mode === 'tcp-zero') { socket.end(Buffer.from([0, 0])); return; }
        if (cfg.mode === 'tcp-trailing') { socket.end(Buffer.concat([frame, Buffer.from([0])])); return; }
        if (cfg.mode === 'tcp-keepalive') { socket.write(frame); return; }
        if (cfg.mode === 'tcp-fragment' || cfg.mode === 'partial-tc') {
          socket.write(frame.subarray(0, 1));
          later(() => { if (!socket.destroyed) socket.write(frame.subarray(1, 7)); }, 5);
          later(() => { if (!socket.destroyed) socket.end(frame.subarray(7)); }, 10);
        } else socket.end(frame);
      });
    } catch { socket.destroy(); }
  });
}
async function bindPair(): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt++) {
    udp = dgram.createSocket('udp4');
    udp.on('message', handleUdp);
    await new Promise<void>((resolve, reject) => {
      udp.once('error', reject);
      udp.bind(0, '127.0.0.1', () => { udp.removeListener('error', reject); resolve(); });
    });
    udp.on('error', () => undefined);
    const port = udp.address().port;
    tcp = net.createServer(handleTcp);
    try {
      await new Promise<void>((resolve, reject) => {
        tcp.once('error', reject);
        tcp.listen(port, '127.0.0.1', () => { tcp.removeListener('error', reject); resolve(); });
      });
      tcp.on('error', () => undefined);
      return port;
    } catch (error) {
      await new Promise<void>(resolve => udp.close(resolve));
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || attempt === 2) throw error;
    }
  }
  throw new Error('Unable to allocate a loopback service pair');
}
let closePromise: Promise<void> | undefined;
function shutdown(): Promise<void> {
  return closePromise ??= (async () => {
    stopping = true;
    held.length = 0;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    const closed = [...connections].map(socket => new Promise<void>(resolve => { socket.once('close', resolve); socket.destroy(); }));
    await Promise.all([
      ...closed,
      new Promise<void>(resolve => { if (tcp?.listening) tcp.close(() => resolve()); else resolve(); }),
      new Promise<void>(resolve => { try { udp?.close(() => resolve()); } catch { resolve(); } })
    ]);
  })();
}
void (async () => {
  const port = await bindPair();
  serve(async (command, body) => {
    if (command === 'configure') { config = scenario(body); return null; }
    if (command === 'stats') return { ...counts, held: held.length, connections: connections.size };
    if (command === 'release') { const actions = held.splice(0); for (const action of actions) action(); return actions.length; }
    throw new Error('Unknown authority command');
  }, shutdown);
  await send({ kind: 'ready', port });
})().catch(async () => {
  await shutdown();
  await send({ kind: 'fatal', message: 'Authority startup failed' }).catch(() => undefined);
  if (process.connected) process.disconnect();
  process.exitCode = 1;
});
