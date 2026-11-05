import { DnsLabClient } from '../src/client';
import { QueryType } from '../src/names';
import { object, send, serve } from './protocol';

const client = new DnsLabClient({ address: '127.0.0.1', port: Number(process.argv[2]), deadlineMs: Number(process.argv[3]) });
const pending = new Set<Promise<unknown>>();
serve(async (command, body) => {
  if (command === 'inspect') return client.inspectCounters();
  if (command === 'clear') { client.clearCache(); return null; }
  if (command !== 'query') throw new Error('Unknown client command');
  const o = object(body);
  if (Object.keys(o).some(k => !['name', 'type', 'nowMs'].includes(k)) || typeof o.name !== 'string' || o.name.length > 254 || typeof o.type !== 'string' || typeof o.nowMs !== 'number') throw new Error('Invalid query command');
  const promise = client.query(o.name, o.type as QueryType, o.nowMs);
  pending.add(promise);
  try { return await promise; } finally { pending.delete(promise); }
}, async () => {
  // Clearing is not cancellation: admitted requests keep their slots until closed.
  client.clearCache();
  await Promise.allSettled([...pending]);
});
void send({ kind: 'ready' }).catch(() => { process.exitCode = 1; });
