import * as dgram from 'node:dgram';
import * as net from 'node:net';
import { performance } from 'node:perf_hooks';
import { asLabError, LabError } from './errors';
import { checkResponseFlags, decodeStrict, Parsed, Question, questionMatches } from './wire';

export interface TransportCounters { udp: number; tcp: number; ignoredResponses: number; openSockets: number }
export interface Endpoint { address: '127.0.0.1'; port: number; udpBytes: number; tcpBytes: number }

export class Transport {
  constructor(private readonly endpoint: Endpoint, private readonly counters: TransportCounters) {}
  async exchange(bytes: Buffer, question: Question, id: number, deadline: number): Promise<{ parsed: Parsed; transport: 'udp' | 'tcp' }> {
    let ignored = 0;
    const ignore = (): void => {
      if (ignored >= 8) throw new LabError('LimitExceeded', 'More than eight mismatched responses');
      ignored++;
      this.counters.ignoredResponses++;
    };
    const parse = (message: Buffer, tcp: boolean): Parsed | undefined => {
      if (message.length >= 2 && message.readUInt16BE(0) !== id) { ignore(); return undefined; }
      const parsed = decodeStrict(message, tcp ? this.endpoint.tcpBytes : this.endpoint.udpBytes, !tcp);
      if (!questionMatches(parsed, id, question)) { ignore(); return undefined; }
      checkResponseFlags(parsed, tcp);
      return parsed;
    };
    const udp = await this.udp(bytes, deadline, parse, ignore);
    if (!checkResponseFlags(udp, false)) return { parsed: udp, transport: 'udp' };
    return { parsed: await this.tcp(bytes, deadline, parse), transport: 'tcp' };
  }
  private remaining(deadline: number): number {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new LabError('DeadlineExceeded', 'Request deadline elapsed');
    return remaining;
  }
  private udp(bytes: Buffer, deadline: number, parse: (b: Buffer, tcp: boolean) => Parsed | undefined, ignore: () => void): Promise<Parsed> {
    const remaining = this.remaining(deadline);
    return new Promise<Parsed>((resolve, reject) => {
      const socket = dgram.createSocket('udp4');
      this.counters.openSockets++;
      let ending = false;
      let finalized = false;
      let value: Parsed | undefined;
      let failure: LabError | undefined;
      const finalize = (): void => {
        if (finalized) return;
        finalized = true;
        clearTimeout(timer);
        this.counters.openSockets--;
        if (failure) reject(failure);
        else if (value) resolve(value);
        else reject(new LabError('NetworkError', 'UDP closed without a response'));
      };
      const finish = (error?: unknown, result?: Parsed): void => {
        if (ending) return;
        ending = true;
        failure = error === undefined ? undefined : asLabError(error);
        value = result;
        clearTimeout(timer);
        try { socket.close(); } catch { finalize(); }
      };
      const timer = setTimeout(() => finish(new LabError('DeadlineExceeded', 'Request deadline elapsed')), remaining);
      socket.on('close', finalize);
      socket.on('error', error => finish(error));
      socket.on('message', (message, source) => {
        if (ending) return;
        try {
          if (source.address !== this.endpoint.address || source.port !== this.endpoint.port) { ignore(); return; }
          if (message.length > this.endpoint.udpBytes) throw new LabError('LimitExceeded', 'UDP response exceeds limit');
          const parsed = parse(message, false);
          if (parsed) finish(undefined, parsed);
        } catch (error) { finish(error); }
      });
      try {
        socket.bind(0, '127.0.0.1', () => {
          if (ending) return;
          if (performance.now() >= deadline) { finish(new LabError('DeadlineExceeded', 'Request deadline elapsed')); return; }
          this.counters.udp++;
          socket.send(bytes, this.endpoint.port, this.endpoint.address, error => { if (error) finish(error); });
        });
      } catch (error) { finish(error); }
    });
  }
  private tcp(bytes: Buffer, deadline: number, parse: (b: Buffer, tcp: boolean) => Parsed | undefined): Promise<Parsed> {
    const remaining = this.remaining(deadline);
    return new Promise<Parsed>((resolve, reject) => {
      const socket = new net.Socket();
      this.counters.openSockets++;
      this.counters.tcp++;
      let ending = false;
      let failure: LabError | undefined;
      let value: Parsed | undefined;
      let buffer = Buffer.alloc(0);
      let length: number | undefined;
      const finish = (error?: unknown, result?: Parsed): void => {
        if (ending) return;
        ending = true;
        failure = error === undefined ? undefined : asLabError(error);
        value = result;
        clearTimeout(timer);
        socket.destroy();
      };
      const timer = setTimeout(() => finish(new LabError('DeadlineExceeded', 'Request deadline elapsed')), remaining);
      socket.on('error', error => finish(error));
      socket.on('close', () => {
        clearTimeout(timer);
        this.counters.openSockets--;
        if (failure) reject(failure);
        else if (value) resolve(value);
        else reject(new LabError('ProtocolError', 'TCP closed before a complete response'));
      });
      socket.on('data', chunk => {
        if (ending) return;
        try {
          if (buffer.length + chunk.length > this.endpoint.tcpBytes + 2) throw new LabError('LimitExceeded', 'TCP response exceeds limit');
          buffer = Buffer.concat([buffer, chunk]);
          if (buffer.length >= 2 && length === undefined) {
            length = buffer.readUInt16BE(0);
            if (length < 12) throw new LabError('DecodeError', 'TCP message length below DNS header size');
            if (length > this.endpoint.tcpBytes) throw new LabError('LimitExceeded', 'TCP length exceeds limit');
          }
          if (length !== undefined && buffer.length > length + 2) throw new LabError('DecodeError', 'Trailing TCP frame data');
          if (length !== undefined && buffer.length === length + 2) {
            const parsed = parse(buffer.subarray(2), true);
            if (!parsed) throw new LabError('ProtocolError', 'Mismatched TCP response');
            finish(undefined, parsed);
          }
        } catch (error) { finish(error); }
      });
      socket.on('end', () => {
        if (ending) return;
        try {
          if (length === undefined || buffer.length !== length + 2) throw new LabError('DecodeError', 'Early TCP EOF');
          throw new LabError('DecodeError', 'TCP ended before a complete response was accepted');
        } catch (error) { finish(error); }
      });
      try {
        socket.connect({ host: this.endpoint.address, port: this.endpoint.port, localAddress: '127.0.0.1' }, () => {
          if (ending) return;
          if (socket.remoteAddress !== this.endpoint.address || socket.remotePort !== this.endpoint.port) {
            finish(new LabError('ProtocolError', 'Unexpected TCP peer')); return;
          }
          const prefix = Buffer.alloc(2);
          prefix.writeUInt16BE(bytes.length);
          socket.write(Buffer.concat([prefix, bytes]));
        });
      } catch (error) { finish(error); }
    });
  }
}
