import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { withLab, until, resourceReport } from '../lab/harness';
import { runScenarios } from '../lab/scenarios';

test('six acceptance scenarios over separate client and authority processes', { timeout: 20000 }, async () => {
  await runScenarios();
  assert.deepEqual(resourceReport(), { liveChildren: 0, openServiceListeners: 0 });
});
test('silent deadline closes sockets; a clean retry succeeds', async () => {
  await withLab(async lab => {
    await lab.configure({ mode: 'silent' });
    await assert.rejects(lab.query('a.example.test', 'A', 0), { code: 'DeadlineExceeded' });
    const failed = await lab.inspect();
    assert.equal(failed.cacheEntries, 0);
    assert.equal(failed.openSockets, 0);
    assert.equal(failed.active, 0);
    await lab.configure({ mode: 'positive' });
    assert.deepEqual((await lab.query('a.example.test', 'A', 0)).addresses, ['192.0.2.8']);
    assert.equal((await lab.stats()).udp, 2);
  }, { deadlineMs: 100 });
});
test('non-ancestor SOA cannot cache a suffix-spoofed NXDOMAIN', async () => {
  await withLab(async lab => {
    await lab.configure({ mode: 'spoof-soa' });
    for (let i = 0; i < 2; i++) {
      const r = await lab.query('badexample.test', 'A', 0);
      assert.equal(r.status, 'NXDOMAIN');
      assert.equal(r.ttlSeconds, 0);
    }
    assert.equal((await lab.stats()).udp, 2);
  });
});
test('invalid and regressing logical time do not allocate sockets', async () => {
  await withLab(async lab => {
    await lab.query('a.example.test', 'A', 10);
    for (const now of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(lab.query('b.example.test', 'A', now), { code: 'InvalidArgument' });
    await assert.rejects(lab.query('b.example.test', 'A', 9), { code: 'ClockRegression' });
    assert.equal((await lab.stats()).udp, 1);
    assert.equal((await lab.inspect()).logicalQueries, 1);
  });
});
test('non-ASCII case folding cannot turn an unsupported name into an ASCII query', async () => {
  await withLab(async lab => {
    await assert.rejects(lab.query('\u212a.example.test', 'A', 0), { code: 'InvalidArgument' });
    assert.equal((await lab.stats()).udp, 0);
    assert.equal((await lab.inspect()).logicalQueries, 0);
  });
});
test('TTL zero and expiry overflow do not publish', async () => {
  await withLab(async lab => {
    await lab.configure({ mode: 'positive', ttl: 0 });
    await lab.query('a.example.test', 'A', 0);
    await lab.query('a.example.test', 'A', 0);
    assert.equal((await lab.stats()).udp, 2);
    await lab.configure({ mode: 'positive' });
    await assert.rejects(lab.query('b.example.test', 'A', Number.MAX_SAFE_INTEGER - 1), { code: 'LimitExceeded' });
    assert.equal((await lab.inspect()).cacheEntries, 0);
  });
});
test('four admitted requests remain busy across clear until their sockets settle', async () => {
  await withLab(async lab => {
    await lab.configure({ mode: 'positive', hold: true });
    const pending = [0, 1, 2, 3].map(i => lab.query(`n${i}.example.test`, 'A', 0));
    await until(async () => (await lab.stats()).held === 4, 'four held requests');
    await assert.rejects(lab.query('fifth.example.test', 'A', 0), { code: 'Busy' });
    await lab.clear();
    await assert.rejects(lab.query('fifth.example.test', 'A', 0), { code: 'Busy' });
    assert.equal((await lab.stats()).udp, 4);
    assert.equal((await lab.inspect()).openSockets, 4);
    await lab.release();
    await Promise.all(pending);
    const final = await lab.inspect();
    assert.equal(final.active, 0);
    assert.equal(final.openSockets, 0);
    assert.equal(final.cacheEntries, 0);
    assert.equal(final.generationEntries, 0);
  }, { deadlineMs: 1000 });
});
test('late NXDOMAIN cannot overwrite a newer positive for the same name', async () => {
  await withLab(async lab => {
    await lab.configure({ mode: 'nxdomain', hold: true });
    const old = lab.query('race.example.test', 'A', 0);
    await until(async () => (await lab.stats()).held === 1, 'old NXDOMAIN held');
    await lab.configure({ mode: 'positive' });
    await lab.query('race.example.test', 'AAAA', 1);
    await lab.release();
    assert.equal((await old).status, 'NXDOMAIN');
    const current = await lab.query('race.example.test', 'AAAA', 1);
    assert.equal(current.fromCache, true);
    assert.deepEqual(current.addresses, ['::1']);
    assert.equal((await lab.stats()).udp, 2);
  }, { deadlineMs: 1000 });
});
test('clear fences an earlier in-flight answer without cancelling it', async () => {
  await withLab(async lab => {
    await lab.configure({ mode: 'positive', hold: true });
    const old = lab.query('a.example.test', 'A', 0);
    await until(async () => (await lab.stats()).held === 1, 'held before clear');
    await lab.clear();
    await lab.release();
    assert.equal((await old).status, 'positive');
    assert.equal((await lab.inspect()).cacheEntries, 0);
    await lab.configure({ mode: 'positive' });
    assert.equal((await lab.query('a.example.test', 'A', 0)).fromCache, false);
  }, { deadlineMs: 1000 });
});
test('TTL starts at admission, not publication, with a separate logical clock', async () => {
  await withLab(async lab => {
    await lab.configure({ mode: 'positive', hold: true });
    const old = lab.query('old.example.test', 'A', 0);
    await until(async () => (await lab.stats()).held === 1, 'held before time advance');
    await lab.configure({ mode: 'positive' });
    await lab.query('other.example.test', 'A', 2000);
    await lab.release();
    await old;
    assert.equal((await lab.inspect()).cacheEntries, 1);
    assert.equal((await lab.query('old.example.test', 'A', 2000)).fromCache, false);
    assert.equal((await lab.stats()).udp, 3);
  }, { deadlineMs: 1000 });
});
test('distinct names leave no generation history after settlement', async () => {
  await withLab(async lab => {
    await lab.configure({ mode: 'positive', ttl: 0 });
    for (let i = 0; i < 80; i++) await lab.query(`n${i}.example.test`, 'A', 0);
    const state = await lab.inspect();
    assert.equal(state.generationEntries, 0);
    assert.equal(state.cacheEntries, 0);
    state.udp = -1;
    assert.equal((await lab.inspect()).udp, 80);
  });
});
