import { LabError } from '../src/errors';

export const modes = ['positive', 'nxdomain', 'dual', 'truncated', 'partial-tc', 'tcp-keepalive', 'wrong-id', 'malformed', 'no-soa', 'silent', 'spoof-soa', 'tcp-fragment', 'tcp-eof', 'tcp-oversize', 'tcp-zero', 'tcp-tc', 'tcp-trailing', 'flood'] as const;
export type Mode = typeof modes[number];
export interface Scenario { mode: Mode; ttl?: number; hold?: boolean }
export interface Request { id: number; command: string; body: unknown }

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object');
  return value as Record<string, unknown>;
}
export function scenario(value: unknown): Scenario {
  const o = object(value);
  if (Object.keys(o).some(k => !['mode', 'ttl', 'hold'].includes(k)) || !modes.includes(o.mode as Mode)) throw new Error('Invalid scenario');
  if (o.ttl !== undefined && (!Number.isInteger(o.ttl) || (o.ttl as number) < 0 || (o.ttl as number) > 60)) throw new Error('Invalid TTL');
  if (o.hold !== undefined && typeof o.hold !== 'boolean') throw new Error('Invalid hold');
  return o as unknown as Scenario;
}
export function send(message: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.connected || !process.send) { reject(new Error('IPC disconnected')); return; }
    process.send(message, error => error ? reject(error) : resolve());
  });
}
export function serve(handler: (command: string, body: unknown) => Promise<unknown>, shutdown: () => Promise<void>): void {
  let active = 0;
  let stopping = false;
  process.on('message', (raw: unknown) => {
    let req: Request;
    try {
      const o = object(raw);
      if (!Number.isSafeInteger(o.id) || (o.id as number) < 1 || typeof o.command !== 'string' || o.command.length > 32 || JSON.stringify(o).length > 2048) throw new Error('Invalid IPC request');
      req = o as unknown as Request;
    } catch { return; }
    void (async () => {
      try {
        if (stopping || active >= 16) throw new Error('IPC admission limit');
        active++;
        try {
          if (req.command === 'shutdown') {
            stopping = true;
            await shutdown();
            await send({ kind: 'reply', id: req.id, ok: true, value: null });
            process.disconnect();
          } else {
            const value = await handler(req.command, req.body);
            await send({ kind: 'reply', id: req.id, ok: true, value });
          }
        } finally { active--; }
      } catch (error) {
        await send({ kind: 'reply', id: req.id, ok: false, error: {
          code: error instanceof LabError ? error.code : 'ProtocolError',
          message: error instanceof Error ? error.message.slice(0, 200) : 'Worker failure'
        } }).catch(() => undefined);
      }
    })();
  });
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void shutdown().finally(() => { if (process.connected) process.disconnect(); });
  };
  process.on('disconnect', stop);
  process.on('SIGTERM', stop);
}
