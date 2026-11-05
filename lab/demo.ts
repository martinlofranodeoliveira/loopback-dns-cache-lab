import * as assert from 'node:assert/strict';
import { resourceReport } from './harness';
import { runScenarios, scenarioNames } from './scenarios';

void (async () => {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--assert' && args[0] !== '--json')) throw new Error('Use --assert or --json');
  await runScenarios();
  assert.deepEqual(resourceReport(), { liveChildren: 0, openServiceListeners: 0 });
  if (args[0] === '--json') {
    process.stdout.write(JSON.stringify({ version: '0.1.0', ok: true, scenarios: scenarioNames, cleanup: resourceReport() }) + '\n');
  } else process.stdout.write('DEMO_OK scenarios=6\n');
})().catch(error => {
  process.stderr.write(`DEMO_FAILED ${error instanceof Error ? error.message : 'unknown failure'}\n`);
  process.exitCode = 1;
});
