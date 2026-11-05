import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as dgram from 'node:dgram';
import * as net from 'node:net';
import { performance } from 'node:perf_hooks';
import { DnsLabClient } from '../src/client';
import { decodeStrict, encode } from '../src/wire';
import { Transport } from '../src/transport';
import { withLab } from '../lab/harness';
import { Mode } from '../lab/protocol';

test('fragmented TCP prefix and body are accepted', async () => {
  await withLab(async lab => {
    await lab.configure({ mode: 'tcp-fragment' });
    assert.deepEqual((await lab.query('a.example.test', 'A', 0)).addresses, ['192.0.2.8']);
    assert.equal((await lab.inspect()).tcp, 1);
    assert.equal((await lab.inspect()).openSockets, 0);
  });
});
for (const mode of ['partial-tc', 'tcp-keepalive'] as const) {
  test(`${mode}: a complete TCP frame succeeds without interpreting a partial UDP body or waiting for EOF`, async () => {
    await withLab(async lab => {
      await lab.configure({ mode });
      assert.deepEqual((await lab.query('a.example.test', 'A', 0)).addresses, ['192.0.2.8']);
      const counters = await lab.inspect();
      assert.equal(counters.udp, 1);
      assert.equal(counters.tcp, 1);
      assert.equal(counters.openSockets, 0);
      assert.equal(counters.cacheEntries, 1);
    });
  });
}
for (const [mode, code] of [
  ['tcp-eof', 'DecodeError'], ['tcp-oversize', 'LimitExceeded'], ['tcp-zero', 'DecodeError'],
  ['tcp-tc', 'ProtocolError'], ['tcp-trailing', 'DecodeError'], ['flood', 'LimitExceeded']
] as const) {
  test(`${mode} fails closed and allows a later clean retry`, async () => {
    await withLab(async lab => {
      await lab.configure({ mode: mode as Mode });
      await assert.rejects(lab.query('a.example.test', 'A', 0), { code });
      const failed = await lab.inspect();
      assert.equal(failed.cacheEntries, 0);
      assert.equal(failed.active, 0);
      assert.equal(failed.openSockets, 0);
      if (mode === 'flood') assert.equal(failed.ignoredResponses, 8);
      await lab.configure({ mode: 'positive' });
      assert.deepEqual((await lab.query('a.example.test', 'A', 0)).addresses, ['192.0.2.8']);
    });
  });
}
async function bindUdp(socket: dgram.Socket): Promise<number> {
  await new Promise<void>(resolve => socket.bind(0, '127.0.0.1', resolve));
  return socket.address().port;
}
async function closeUdp(socket: dgram.Socket): Promise<void> { await new Promise<void>(resolve => socket.close(resolve)); }

test('wrong source port and wrong question are ignored before a valid reply', async () => {
  const server = dgram.createSocket('udp4');
  const noise = dgram.createSocket('udp4');
  const timers: NodeJS.Timeout[] = [];
  const port = await bindUdp(server);
  await bindUdp(noise);
  server.on('message', (request, peer) => {
    const q = decodeStrict(request).packet;
    const response = encode({ ...q, type: 'response', flags: 0x0400, answers: [{ ...q.questions[0]!, ttl: 2, data: '192.0.2.8' }] });
    noise.send(response, peer.port, '127.0.0.1');
    const wrongQuestion = encode({ ...q, type: 'response', flags: 0x0400, questions: [{ ...q.questions[0]!, name: 'wrong.example.test' }] });
    timers.push(setTimeout(() => server.send(wrongQuestion, peer.port, '127.0.0.1'), 5));
    timers.push(setTimeout(() => server.send(response, peer.port, '127.0.0.1'), 10));
  });
  try {
    const client = new DnsLabClient({ address: '127.0.0.1', port });
    assert.deepEqual((await client.query('a.example.test', 'A', 0)).addresses, ['192.0.2.8']);
    assert.equal(client.inspectCounters().ignoredResponses, 2);
  } finally {
    for (const timer of timers) clearTimeout(timer);
    await closeUdp(server);
    await closeUdp(noise);
  }
});
test('all sub-header TCP lengths fail immediately even when the peer keeps the connection open', async () => {
  for (let length = 1; length < 12; length++) {
    const udp = dgram.createSocket('udp4');
    const port = await bindUdp(udp);
    const peers = new Set<net.Socket>();
    const tcp = net.createServer(socket => {
      peers.add(socket);
      socket.on('error', () => undefined);
      socket.on('close', () => peers.delete(socket));
      socket.once('data', () => {
        // Independent malformed framing fixture: the peer sends only its
        // length prefix and deliberately never sends a body or EOF.
        socket.write(Buffer.from([0, length]));
      });
    });
    await new Promise<void>(resolve => tcp.listen(port, '127.0.0.1', resolve));
    udp.on('message', (message, peer) => {
      const query = decodeStrict(message).packet;
      udp.send(encode({ ...query, type: 'response', flags: 0x0600 }), peer.port, '127.0.0.1');
    });
    try {
      const client = new DnsLabClient({ address: '127.0.0.1', port, deadlineMs: 200 });
      await assert.rejects(client.query('a.example.test', 'A', 0), { code: 'DecodeError' }, `prefix ${length}`);
      const counters = client.inspectCounters();
      assert.equal(counters.tcp, 1);
      assert.equal(counters.openSockets, 0);
      assert.equal(counters.active, 0);
      assert.equal(counters.cacheEntries, 0);
    } finally {
      await Promise.all([...peers].map(socket => new Promise<void>(resolve => { socket.once('close', resolve); socket.destroy(); })));
      await new Promise<void>(resolve => tcp.close(() => resolve()));
      await closeUdp(udp);
    }
  }
});
test('one monotonic deadline spans delayed UDP and a never-ending TCP response', async () => {
  const udp = dgram.createSocket('udp4');
  const port = await bindUdp(udp);
  const peers = new Set<net.Socket>();
  const tcp = net.createServer(socket => { peers.add(socket); socket.on('error', () => undefined); socket.on('close', () => peers.delete(socket)); });
  await new Promise<void>(resolve => tcp.listen(port, '127.0.0.1', resolve));
  const timers: NodeJS.Timeout[] = [];
  udp.on('message', (message, peer) => {
    const query = decodeStrict(message).packet;
    timers.push(setTimeout(() => udp.send(encode({ ...query, type: 'response', flags: 0x0600 }), peer.port, '127.0.0.1'), 60));
  });
  try {
    const counters = { udp: 0, tcp: 0, ignoredResponses: 0, openSockets: 0 };
    const transport = new Transport({ address: '127.0.0.1', port, udpBytes: 4096, tcpBytes: 16384 }, counters);
    const q = { name: 'a.example.test', type: 'A', class: 'IN' };
    // A deterministic transaction ID exists only in this internal transport test.
    await assert.rejects(transport.exchange(encode({ id: 42, type: 'query', flags: 0, questions: [q] }), q, 42, performance.now() + 120), { code: 'DeadlineExceeded' });
    assert.equal(counters.udp, 1);
    assert.equal(counters.tcp, 1);
    assert.equal(counters.openSockets, 0);
  } finally {
    for (const timer of timers) clearTimeout(timer);
    await Promise.all([...peers].map(socket => new Promise<void>(resolve => { socket.once('close', resolve); socket.destroy(); })));
    await new Promise<void>(resolve => tcp.close(() => resolve()));
    await closeUdp(udp);
  }
});
