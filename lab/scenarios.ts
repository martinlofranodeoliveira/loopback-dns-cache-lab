import * as assert from 'node:assert/strict';
import { withLab } from './harness';

export const scenarioNames = ['positive-expiry', 'nxdomain-cross-type', 'nodata-type-isolation', 'udp-tcp-fallback', 'mismatch-and-malformed', 'uncached-negative'] as const;

export async function runScenarios(): Promise<void> {
  await withLab(async lab => {
    await lab.configure({ mode: 'positive' });
    assert.deepEqual((await lab.query('a.example.test', 'A', 0)).addresses, ['192.0.2.8']);
    assert.equal((await lab.query('A.Example.Test.', 'A', 1999)).fromCache, true);
    assert.equal((await lab.query('a.example.test', 'A', 2000)).fromCache, false);
    assert.equal((await lab.stats()).udp, 2);
  });
  await withLab(async lab => {
    await lab.configure({ mode: 'nxdomain' });
    assert.equal((await lab.query('missing.example.test', 'A', 0)).status, 'NXDOMAIN');
    assert.equal((await lab.query('missing.example.test', 'AAAA', 2999)).fromCache, true);
    await lab.query('missing.example.test', 'AAAA', 3000);
    assert.equal((await lab.stats()).udp, 2);
  });
  await withLab(async lab => {
    await lab.configure({ mode: 'dual' });
    assert.equal((await lab.query('dual.example.test', 'A', 0)).status, 'NODATA');
    assert.deepEqual((await lab.query('dual.example.test', 'AAAA', 0)).addresses, ['::1']);
    assert.equal((await lab.stats()).udp, 2);
  });
  await withLab(async lab => {
    await lab.configure({ mode: 'truncated' });
    const result = await lab.query('a.example.test', 'A', 0);
    assert.deepEqual(result.addresses, ['192.0.2.8']);
    assert.equal(result.transport, 'tcp');
    const counters = await lab.inspect();
    assert.equal(counters.udp, 1);
    assert.equal(counters.tcp, 1);
  });
  await withLab(async lab => {
    await lab.configure({ mode: 'wrong-id' });
    assert.deepEqual((await lab.query('a.example.test', 'A', 0)).addresses, ['192.0.2.8']);
    assert.equal((await lab.inspect()).ignoredResponses, 1);
    await lab.clear();
    await lab.configure({ mode: 'malformed' });
    await assert.rejects(lab.query('a.example.test', 'A', 0), { code: 'DecodeError' });
    assert.equal((await lab.inspect()).cacheEntries, 0);
  });
  await withLab(async lab => {
    await lab.configure({ mode: 'no-soa' });
    for (let i = 0; i < 2; i++) {
      const result = await lab.query('missing.example.test', 'A', 0);
      assert.equal(result.status, 'NXDOMAIN');
      assert.equal(result.fromCache, false);
    }
    assert.equal((await lab.stats()).udp, 2);
    assert.equal((await lab.inspect()).cacheEntries, 0);
  });
}
