import { ChildProcess, fork } from 'node:child_process';
import * as dgram from 'node:dgram';
import * as net from 'node:net';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Counters } from '../src/client';
import { ErrorCode, LabError } from '../src/errors';
import { QueryType } from '../src/names';
import { QueryResult } from '../src/result';
import { object, Scenario } from './protocol';

const live = new Set<ChildProcess>();
const ownedPorts = new Set<number>();
export function resourceReport(): { liveChildren: number; openServiceListeners: number } {
  return { liveChildren: live.size, openServiceListeners: ownedPorts.size };
}

class Worker {
  readonly child: ChildProcess;
  readonly ready: Promise<Record<string, unknown>>;
  readonly exited: Promise<void>;
  private sequence = 0;
  private dead = false;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: NodeJS.Timeout }>();
  constructor(file: string, args: string[] = []) {
    this.child = fork(path.join(__dirname, file), args, { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'json' });
    live.add(this.child);
    let diagnostics = '';
    this.child.stderr?.on('data', (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString()).slice(-4096); });
    let readyResolve!: (v: Record<string, unknown>) => void;
    let readyReject!: (e: unknown) => void;
    this.ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const readyTimer = setTimeout(() => readyReject(new Error('Worker readiness deadline')), 4000);
    this.exited = new Promise(resolve => {
      this.child.once('exit', () => {
        this.dead = true;
        live.delete(this.child);
        clearTimeout(readyTimer);
        const error = new Error(`Worker exited${diagnostics ? ': ' + diagnostics : ''}`);
        readyReject(error);
        for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
        this.pending.clear();
        resolve();
      });
    });
    this.child.on('error', error => { clearTimeout(readyTimer); readyReject(error); });
    this.child.on('message', (raw: unknown) => {
      try {
        const msg = object(raw);
        if (msg.kind === 'ready') { clearTimeout(readyTimer); readyResolve(msg); return; }
        if (msg.kind === 'fatal') { clearTimeout(readyTimer); readyReject(new Error(String(msg.message))); return; }
        if (msg.kind !== 'reply' || typeof msg.id !== 'number') return;
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.ok === true) entry.resolve(msg.value);
        else {
          const error = object(msg.error);
          entry.reject(new LabError(error.code as ErrorCode, String(error.message)));
        }
      } catch { /* Only bounded, recognized messages affect parent state. */ }
    });
  }
  call<T>(command: string, body: unknown = null): Promise<T> {
    if (this.dead || !this.child.connected || this.pending.size >= 16) return Promise.reject(new Error('Worker unavailable or IPC full'));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('IPC deadline')); }, 4000);
      this.pending.set(id, { resolve: v => resolve(v as T), reject, timer });
      this.child.send({ id, command, body }, error => {
        if (!error) return;
        const entry = this.pending.get(id);
        if (entry) { this.pending.delete(id); clearTimeout(entry.timer); reject(error); }
      });
    });
  }
  async stop(): Promise<void> {
    if (this.dead) { await this.exited; return; }
    const grace = setTimeout(() => { this.child.kill('SIGTERM'); }, 1500);
    const force = setTimeout(() => { this.child.kill('SIGKILL'); }, 2500);
    try {
      await this.call('shutdown').catch(() => undefined);
      await this.exited;
    } finally { clearTimeout(grace); clearTimeout(force); }
  }
  async crash(): Promise<void> { this.child.kill('SIGKILL'); await this.exited; }
}

async function verifyReleased(port: number): Promise<void> {
  const udp = dgram.createSocket('udp4');
  const tcp = net.createServer();
  try {
    await new Promise<void>((resolve, reject) => { udp.once('error', reject); udp.bind(port, '127.0.0.1', resolve); });
    await new Promise<void>((resolve, reject) => { tcp.once('error', reject); tcp.listen(port, '127.0.0.1', resolve); });
  } finally {
    await Promise.all([
      new Promise<void>(resolve => { try { udp.close(resolve); } catch { resolve(); } }),
      new Promise<void>(resolve => { if (tcp.listening) tcp.close(() => resolve()); else resolve(); })
    ]);
  }
}
export interface HarnessOptions { deadlineMs?: number; failAfter?: 'authority' | 'client' }
export interface AuthorityStats { udp: number; tcp: number; answers: number; held: number; connections: number }
export class Harness {
  private authority?: Worker;
  private client?: Worker;
  private port?: number;
  async start(options: HarnessOptions = {}): Promise<void> {
    this.authority = new Worker('authority.js');
    const ready = await this.authority.ready;
    if (!Number.isInteger(ready.port) || (ready.port as number) < 1 || (ready.port as number) > 65535) throw new Error('Invalid authority readiness');
    this.port = ready.port as number;
    ownedPorts.add(this.port);
    if (options.failAfter === 'authority') throw new Error('Deliberate startup failure after authority');
    const deadline = options.deadlineMs ?? 500;
    if (!Number.isInteger(deadline) || deadline < 1 || deadline > 1000) throw new Error('Invalid harness deadline');
    this.client = new Worker('client-worker.js', [String(this.port), String(deadline)]);
    await this.client.ready;
    if (options.failAfter === 'client') throw new Error('Deliberate startup failure after client');
  }
  configure(config: Scenario): Promise<void> { return this.authority!.call('configure', config); }
  stats(): Promise<AuthorityStats> { return this.authority!.call('stats'); }
  release(): Promise<number> { return this.authority!.call('release'); }
  query(name: string, type: QueryType, nowMs: number): Promise<QueryResult> { return this.client!.call('query', { name, type, nowMs }); }
  inspect(): Promise<Counters> { return this.client!.call('inspect'); }
  clear(): Promise<void> { return this.client!.call('clear'); }
  async crashClient(): Promise<void> { await this.client!.crash(); }
  async close(): Promise<void> {
    try { await this.client?.stop(); } finally {
      await this.authority?.stop();
      if (this.port !== undefined) {
        await verifyReleased(this.port);
        ownedPorts.delete(this.port);
        this.port = undefined;
      }
    }
  }
}
export async function withLab<T>(fn: (lab: Harness) => Promise<T>, options: HarnessOptions = {}): Promise<T> {
  const lab = new Harness();
  try { await lab.start(options); return await fn(lab); } finally { await lab.close(); }
}
export async function until(check: () => Promise<boolean>, label: string): Promise<void> {
  const end = performance.now() + 2500;
  while (performance.now() < end) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Barrier not reached: ${label}`);
}
