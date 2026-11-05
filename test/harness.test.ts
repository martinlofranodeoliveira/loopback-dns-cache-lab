import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { resourceReport, withLab } from '../lab/harness';

const empty = { liveChildren: 0, openServiceListeners: 0 };
test('harness reaps children and rebinds its service port after normal completion', async () => {
  await withLab(async lab => { await lab.query('a.example.test', 'A', 0); });
  assert.deepEqual(resourceReport(), empty);
});
for (const failAfter of ['authority', 'client'] as const) {
  test(`startup failure after ${failAfter} reaps every started child`, async () => {
    await assert.rejects(withLab(async () => undefined, { failAfter }), /Deliberate startup failure/);
    assert.deepEqual(resourceReport(), empty);
  });
}
test('body failure and abrupt client exit both leave no owned listeners', async () => {
  await assert.rejects(withLab(async () => { throw new Error('Deliberate body failure'); }), /Deliberate body failure/);
  assert.deepEqual(resourceReport(), empty);
  await withLab(async lab => { await lab.crashClient(); });
  assert.deepEqual(resourceReport(), empty);
});
test('shutdown waits for admitted silent requests rather than freeing their slots early', async () => {
  await withLab(async lab => {
    await lab.configure({ mode: 'silent' });
    const pending = lab.query('a.example.test', 'A', 0);
    // Register rejection handling before leaving the body; shutdown must settle it.
    void pending.catch(() => undefined);
  }, { deadlineMs: 100 });
  assert.deepEqual(resourceReport(), empty);
});
test('demo has an exact stdout contract and bounded subprocess cleanup', { timeout: 20000 }, async () => {
  const child = spawn(process.execPath, [path.join(__dirname, '../lab/demo.js'), '--assert'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (b: Buffer) => { stdout = (stdout + b.toString()).slice(-8192); });
  child.stderr.on('data', (b: Buffer) => { stderr = (stderr + b.toString()).slice(-8192); });
  const timer = setTimeout(() => child.kill('SIGTERM'), 15000);
  const force = setTimeout(() => child.kill('SIGKILL'), 17000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(code, 0, stderr);
    assert.equal(stdout, 'DEMO_OK scenarios=6\n');
    assert.equal(stderr, '');
  } finally { clearTimeout(timer); clearTimeout(force); }
});
