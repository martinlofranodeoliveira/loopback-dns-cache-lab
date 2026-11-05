import { LabError } from './errors';
import { QueryType } from './names';
import { detached, QueryResult } from './result';

interface Entry { result: QueryResult; expiresAt: number }

export class Cache {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly capacity: number) {}
  private key(name: string, type: string): string { return `${name}|IN|${type}`; }
  clear(): void { this.entries.clear(); }
  size(now: number): number { this.expire(now); return this.entries.size; }
  private expire(now: number): void {
    for (const [key, entry] of this.entries) if (now >= entry.expiresAt) this.entries.delete(key);
  }
  get(name: string, type: QueryType, now: number): QueryResult | undefined {
    this.expire(now);
    for (const key of [this.key(name, '*'), this.key(name, type)]) {
      const entry = this.entries.get(key);
      if (!entry) continue;
      this.entries.delete(key);
      this.entries.set(key, entry);
      return { ...detached(entry.result), type, fromCache: true, transport: 'cache' };
    }
    return undefined;
  }
  put(result: QueryResult, admittedNow: number, currentNow: number): void {
    const ttl = result.ttlSeconds;
    if (!Number.isInteger(ttl) || ttl < 0 || ttl > 0xffffffff || ttl > Math.floor((Number.MAX_SAFE_INTEGER - admittedNow) / 1000)) {
      throw new LabError('LimitExceeded', 'Cache expiry exceeds the safe integer range');
    }
    const expiresAt = admittedNow + ttl * 1000;
    this.expire(currentNow);
    // Contradictory entries are removed even when a new TTL is zero.
    for (const [key, entry] of this.entries) {
      if (entry.result.name === result.name && (result.status === 'NXDOMAIN' || entry.result.status === 'NXDOMAIN')) {
        this.entries.delete(key);
      }
    }
    const key = this.key(result.name, result.status === 'NXDOMAIN' ? '*' : result.type);
    this.entries.delete(key);
    if (ttl === 0 || currentNow >= expiresAt) return;
    this.entries.set(key, { result: detached(result), expiresAt });
    while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
  }
}
