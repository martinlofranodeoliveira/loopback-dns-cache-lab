import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { checkResponseFlags, decodeStrict, encode, questionMatches } from '../src/wire';
import { interpret } from '../src/result';
import { bytes, fixed } from './fixtures';

const q = { name: 'a.example.test', type: 'A', class: 'IN' };
test('independent A and SOA bytes have the specified meaning', () => {
  const a = decodeStrict(bytes(fixed.a));
  assert.equal(questionMatches(a, 0x1234, q), true);
  assert.deepEqual(interpret(a, q.name, 'A', 'udp').addresses, ['192.0.2.8']);
  assert.equal(interpret(a, q.name, 'A', 'udp').ttlSeconds, 2);
  const negative = interpret(decodeStrict(bytes(fixed.soa)), q.name, 'A', 'udp');
  assert.equal(negative.status, 'NXDOMAIN');
  assert.equal(negative.ttlSeconds, 3);
});
test('closest applicable SOA ancestor beats root SOA over a single-label TLD', () => {
  const baseSoa = {
    mname: 'ns.example.test', rname: 'hostmaster.example.test',
    serial: 1, refresh: 60, retry: 30, expire: 300
  };
  const parsed = decodeStrict(encode({
    id: 0x1234,
    type: 'response',
    flags: 0x0403,
    questions: [q],
    authorities: [
      { name: '.', type: 'SOA', class: 'IN', ttl: 60, data: { ...baseSoa, minimum: 50 } },
      { name: 'test', type: 'SOA', class: 'IN', ttl: 60, data: { ...baseSoa, minimum: 3 } }
    ]
  }));
  assert.equal(interpret(parsed, q.name, 'A', 'udp').ttlSeconds, 3);
});
for (const key of ['badA', 'badAAAA', 'self', 'forward', 'counts', 'badSoa'] as const) {
  test(`fixed malformed wire rejected: ${key}`, () => {
    assert.throws(() => decodeStrict(bytes(fixed[key])), { code: 'DecodeError' });
  });
}
test('all truncations and trailing bytes fail before partial interpretation', () => {
  const original = bytes(fixed.a);
  for (let length = 0; length < original.length; length++) assert.throws(() => decodeStrict(original.subarray(0, length)), { code: 'DecodeError' });
  assert.throws(() => decodeStrict(Buffer.concat([original, Buffer.from([0])])), { code: 'DecodeError' });
});
test('compression traversal is bounded even for backward, previously seen targets', () => {
  const header = bytes('123484000001001200000000');
  const question = bytes('0161076578616d706c6504746573740000010001');
  const parts = [header, question];
  let previous = 12;
  let offset = header.length + question.length;
  for (let i = 0; i < 18; i++) {
    const rr = bytes('c00000010001000000020004c0000208');
    rr.writeUInt16BE(0xc000 | previous, 0);
    parts.push(rr);
    previous = offset;
    offset += rr.length;
  }
  assert.throws(() => decodeStrict(Buffer.concat(parts)), { code: 'DecodeError' });
});
test('question matching includes canonical name, class, type and ID, and rejects root questions', () => {
  const p = decodeStrict(bytes(fixed.a));
  assert.equal(questionMatches(p, 1, q), false);
  assert.equal(questionMatches(p, 0x1234, { ...q, type: 'AAAA' }), false);
  assert.equal(questionMatches(p, 0x1234, { ...q, name: 'b.example.test' }), false);
  const changed = bytes(fixed.a);
  changed.writeUInt16BE(3, 30);
  assert.equal(questionMatches(decodeStrict(changed), 0x1234, q), false);
  assert.throws(() => decodeStrict(bytes('1234840000010000000000000000010001')), { code: 'DecodeError' });
});
test('a literal dot within one wire label cannot impersonate several hostname labels', () => {
  const flat = bytes(fixed.a);
  // One fourteen-byte label has the same encoded length as a/example/test,
  // but represents a different DNS name. The codec's dotted text loses that distinction.
  bytes('0e612e6578616d706c652e7465737400').copy(flat, 12);
  assert.throws(() => decodeStrict(flat), { code: 'DecodeError' });
});
test('flags reject QR, opcode, AA, reserved bits, recursion and unsupported rcode', () => {
  for (const flags of [0x0400, 0x8c00, 0x8000, 0x8440, 0x8480, 0x8402, 0x8420]) {
    const b = bytes(fixed.a); b.writeUInt16BE(flags, 2);
    assert.throws(() => checkResponseFlags(decodeStrict(b), false), { code: 'ProtocolError' });
  }
  const b = bytes(fixed.a); b.writeUInt16BE(0x8600, 2);
  assert.equal(checkResponseFlags(decodeStrict(b), false), true);
  assert.throws(() => checkResponseFlags(decodeStrict(b), true), { code: 'ProtocolError' });
});
test('aliases, foreign owners and unsupported sections cannot become answers', () => {
  const alias = bytes(fixed.a); alias.writeUInt16BE(5, 34);
  assert.throws(() => decodeStrict(alias), { code: 'ProtocolError' });
  const parsed = decodeStrict(bytes(fixed.a));
  parsed.packet.answers[0]!.name = 'other.example.test';
  assert.throws(() => interpret(parsed, q.name, 'A', 'udp'), { code: 'ProtocolError' });
  parsed.packet.answers[0]!.name = '.';
  assert.throws(() => interpret(parsed, q.name, 'A', 'udp'), { code: 'ProtocolError' });
});
test('positive RRset uses the smallest TTL, not its first record', () => {
  const p = decodeStrict(encode({ id: 3, type: 'response', flags: 0x0400, questions: [q], answers: [
    { ...q, ttl: 30, data: '192.0.2.9' }, { ...q, ttl: 1, data: '192.0.2.8' }
  ] }));
  assert.equal(interpret(p, q.name, 'A', 'udp').ttlSeconds, 1);
});
