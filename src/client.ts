import { randomInt } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Cache } from './cache';
import { integer, LabError } from './errors';
import { normalizeName, queryType, QueryType } from './names';
import { interpret, QueryResult } from './result';
import { Endpoint, Transport, TransportCounters } from './transport';
import { encode, Question } from './wire';

export interface ClientOptions {
  address: '127.0.0.1';
  port: number;
  deadlineMs?: number;
  udpBytes?: number;
  tcpBytes?: number;
  cacheEntries?: number;
}
export interface Counters extends TransportCounters {
  logicalQueries: number;
  cacheHits: number;
  failures: number;
  busyRejected: number;
  active: number;
  cacheEntries: number;
  generationEntries: number;
}

export class DnsLabClient {
  private readonly cache: Cache;
  private readonly transport: Transport;
  private readonly deadlineMs: number;
  private readonly traffic: TransportCounters = { udp: 0, tcp: 0, ignoredResponses: 0, openSockets: 0 };
  private readonly names = new Map<string, { count: number; latest: number }>();
  private epoch = Symbol();
  private sequence = 0;
  private clock = 0;
  private active = 0;
  private logicalQueries = 0;
  private cacheHits = 0;
  private failures = 0;
  private busyRejected = 0;
  constructor(options: ClientOptions) {
    if (options.address !== '127.0.0.1') throw new LabError('InvalidArgument', 'Only numeric 127.0.0.1 endpoints are supported');
    const endpoint: Endpoint = {
      address: '127.0.0.1', port: integer(options.port, 1, 65535, 'port'),
      udpBytes: integer(options.udpBytes ?? 4096, 512, 4096, 'udpBytes'),
      tcpBytes: integer(options.tcpBytes ?? 16384, 512, 16384, 'tcpBytes')
    };
    this.deadlineMs = integer(options.deadlineMs ?? 500, 1, 10000, 'deadlineMs');
    this.cache = new Cache(integer(options.cacheEntries ?? 256, 1, 256, 'cacheEntries'));
    this.transport = new Transport(endpoint, this.traffic);
  }
  clearCache(): void {
    this.epoch = Symbol();
    this.cache.clear();
  }
  inspectCounters(): Counters {
    return { ...this.traffic, logicalQueries: this.logicalQueries, cacheHits: this.cacheHits,
      failures: this.failures, busyRejected: this.busyRejected, active: this.active,
      cacheEntries: this.cache.size(this.clock), generationEntries: this.names.size };
  }
  async query(input: string, requestedType: QueryType, nowMs: number): Promise<QueryResult> {
    if (this.active >= 4) {
      this.busyRejected++;
      throw new LabError('Busy', 'Four requests are already admitted');
    }
    integer(nowMs, 0, Number.MAX_SAFE_INTEGER, 'nowMs');
    if (nowMs < this.clock) throw new LabError('ClockRegression', 'Logical cache time must not decrease');
    const name = normalizeName(input);
    const type = queryType(requestedType);
    if (this.sequence === Number.MAX_SAFE_INTEGER) throw new LabError('LimitExceeded', 'Query sequence exhausted');
    const sequence = ++this.sequence;
    const deadline = performance.now() + this.deadlineMs;
    const epoch = this.epoch;
    this.clock = nowMs;
    this.active++;
    this.logicalQueries++;
    const state = this.names.get(name) ?? { count: 0, latest: sequence };
    state.count++;
    state.latest = sequence;
    this.names.set(name, state);
    try {
      const hit = this.cache.get(name, type, nowMs);
      if (hit) { this.cacheHits++; return hit; }
      const id = randomInt(0, 65536);
      const question: Question = { name, type, class: 'IN' };
      const bytes = encode({ id, type: 'query', flags: 0, questions: [question] });
      const response = await this.transport.exchange(bytes, question, id, deadline);
      const result = interpret(response.parsed, name, type, response.transport);
      if (this.epoch === epoch && state.latest === sequence) this.cache.put(result, nowMs, this.clock);
      return result;
    } catch (error) {
      this.failures++;
      throw error;
    } finally {
      // Transport promises settle only after their owned sockets have closed.
      this.active--;
      if (--state.count === 0) this.names.delete(name);
    }
  }
}
