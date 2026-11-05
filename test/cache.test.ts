import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { Cache } from '../src/cache';
import { DnsLabClient } from '../src/client';
import { isAncestor, normalizeName } from '../src/names';
import { QueryResult } from '../src/result';

function result(name = 'a.example.test', status: QueryResult['status'] = 'positive', ttlSeconds = 2): QueryResult {
  return { name, type: 'A', class: 'IN', status, ttlSeconds, addresses: status === 'positive' ? ['192.0.2.8'] : [], transport: 'udp', fromCache: false };
}
test('expiry is inclusive, and returned arrays cannot mutate entries', () => {
  const c = new Cache(2);
  c.put(result(), 0, 0);
  const hit = c.get('a.example.test', 'A', 1999)!;
  hit.addresses[0] = '192.0.2.99';
  assert.deepEqual(c.get('a.example.test', 'A', 1999)!.addresses, ['192.0.2.8']);
  assert.equal(c.get('a.example.test', 'A', 2000), undefined);
});
test('NXDOMAIN shares types, NODATA does not, and contradictions are removed', () => {
  const c = new Cache(4);
  c.put(result(undefined, 'NXDOMAIN', 3), 0, 0);
  assert.equal(c.get('a.example.test', 'AAAA', 2999)!.type, 'AAAA');
  assert.equal(c.get('a.example.test', 'AAAA', 3000), undefined);
  c.put(result(undefined, 'NODATA', 3), 3000, 3000);
  assert.equal(c.get('a.example.test', 'AAAA', 3000), undefined);
  c.put(result(undefined, 'NXDOMAIN', 3), 3000, 3000);
  assert.equal(c.size(3000), 1);
  c.put({ ...result(), type: 'AAAA', addresses: ['::1'] }, 3000, 3000);
  assert.equal(c.get('a.example.test', 'A', 3000), undefined);
  assert.deepEqual(c.get('a.example.test', 'AAAA', 3000)!.addresses, ['::1']);
});
test('zero TTL, expired publication and overflow never retain answers', () => {
  const c = new Cache(2);
  c.put(result(undefined, 'positive', 0), 0, 0);
  c.put(result(), 0, 2000);
  assert.equal(c.size(2000), 0);
  assert.throws(() => c.put(result(), Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER - 1), { code: 'LimitExceeded' });
  assert.equal(c.size(2000), 0);
});
test('deterministic LRU touches hits and bounds storage across many names', () => {
  const c = new Cache(2);
  c.put(result('a.test'), 0, 0);
  c.put(result('b.test'), 0, 0);
  c.get('a.test', 'A', 0);
  c.put(result('c.test'), 0, 0);
  assert.equal(c.get('b.test', 'A', 0), undefined);
  assert.ok(c.get('a.test', 'A', 0));
  for (let i = 0; i < 1000; i++) c.put(result(`n${i}.test`), 0, 0);
  assert.equal(c.size(0), 2);
  assert.equal(c.get('a.test', 'A', 0), undefined);
});
test('ASCII subset and ancestor comparison use labels, not suffixes', () => {
  assert.equal(normalizeName('A.Example.Test.'), 'a.example.test');
  for (const input of ['localhost..', 'a_b.test', 'é.test', '-a.test', 'a-.test', '.', 'a\\046b.test', 'a'.repeat(64) + '.test']) assert.throws(() => normalizeName(input));
  assert.equal(isAncestor('example.test', 'badexample.test'), false);
  assert.equal(isAncestor('example.test', 'a.example.test'), true);
  assert.equal(isAncestor('', 'a.test'), true);
});
test('endpoint cannot invoke the host resolver or wildcard binding', () => {
  for (const address of ['localhost', '0.0.0.0', '127.0.0.2', '::1', '192.0.2.1']) {
    assert.throws(() => new DnsLabClient({ address: address as '127.0.0.1', port: 53 }), { code: 'InvalidArgument' });
  }
});
