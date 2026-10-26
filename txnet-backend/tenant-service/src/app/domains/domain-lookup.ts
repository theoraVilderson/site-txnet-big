import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resolver } from 'node:dns/promises';
import { request } from 'node:https';
import { randomBytes } from 'node:crypto';

import { acceptOf, readTextFrame } from './ws-frame';

/** What a probe request came back with: an answer, or why there was none. */
export type ProbeAnswer = { status: number; body: unknown } | { error: string };

/** What a WebSocket upgrade came back with: the status and the first message, or why there was none. */
export type UpgradeAnswer = { status: number; frame: string | null } | { error: string };

/**
 * The outside world a domain check reads: public DNS and the domain itself.
 * An interface so the state machine is tested against a scripted world.
 */
export interface DomainLookup {
  /** The TXT strings at `name` (chunks joined); `[]` when there are none. */
  txt(name: string): Promise<string[]>;
  /** The CNAME answers for `host`; `[]` when there are none. */
  cname(host: string): Promise<string[]>;
  /** The A and AAAA answers for `host`; `[]` when there are none (NIN-1-e2). */
  addresses(host: string): Promise<string[]>;
  /** One WebSocket upgrade to an `https:` URL, and the first message after a 101 (NIN-1-e2). */
  upgrade(url: string): Promise<UpgradeAnswer>;
  /** One GET, redirects followed — a CDN sending http to https still serves a visitor. */
  probe(url: string, headers?: Record<string, string>): Promise<ProbeAnswer>;
}

export const DOMAIN_LOOKUP = Symbol('DOMAIN_LOOKUP');

/** A name with no such record is an empty answer, not a failure of the check. */
const NO_RECORD = new Set(['ENODATA', 'ENOTFOUND', 'NXDOMAIN']);

@Injectable()
export class NodeDomainLookup implements DomainLookup {
  private readonly resolver = new Resolver({ timeout: 5_000, tries: 2 });
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.timeoutMs = config.get<number>('DOMAIN_PROBE_TIMEOUT_MS', 10_000);
  }

  async txt(name: string): Promise<string[]> {
    return this.empty(async () => (await this.resolver.resolveTxt(name)).map((chunks) => chunks.join('')));
  }

  async cname(host: string): Promise<string[]> {
    return this.empty(() => this.resolver.resolveCname(host));
  }

  async addresses(host: string): Promise<string[]> {
    const [v4, v6] = await Promise.all([this.empty(() => this.resolver.resolve4(host)), this.empty(() => this.resolver.resolve6(host))]);
    return [...v4, ...v6];
  }

  upgrade(url: string): Promise<UpgradeAnswer> {
    const key = randomBytes(16).toString('base64');
    return new Promise((resolve) => {
      const req = request(url, {
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key },
        timeout: this.timeoutMs,
      });
      req.on('response', (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0, frame: null });
      });
      req.on('upgrade', (res, socket, head) => {
        if (res.headers['sec-websocket-accept'] !== acceptOf(key)) {
          socket.destroy();
          return resolve({ error: 'bad Sec-WebSocket-Accept' });
        }
        let got = head;
        const done = (frame: string | null) => {
          socket.destroy();
          resolve({ status: 101, frame });
        };
        socket.setTimeout(this.timeoutMs, () => done(null));
        socket.on('end', () => done(readTextFrame(got)));
        socket.on('data', (chunk: Buffer) => {
          got = Buffer.concat([got, chunk]);
          const frame = readTextFrame(got);
          if (frame !== null) done(frame);
        });
        if (readTextFrame(got) !== null) done(readTextFrame(got));
      });
      req.on('timeout', () => req.destroy(new Error('ETIMEDOUT')));
      req.on('error', (e: NodeJS.ErrnoException) => resolve({ error: e.code ?? e.message }));
      req.end();
    });
  }

  async probe(url: string, headers: Record<string, string> = {}): Promise<ProbeAnswer> {
    try {
      const response = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(this.timeoutMs) });
      const text = await response.text();
      let body: unknown = null;
      try {
        body = JSON.parse(text);
      } catch {
        // Not JSON: not our answer. The status alone is what the tenant is shown.
      }
      return { status: response.status, body };
    } catch (e) {
      const cause = (e as { cause?: { code?: string } }).cause?.code;
      return { error: cause ?? (e as Error).name ?? 'error' };
    }
  }

  private async empty(read: () => Promise<string[]>): Promise<string[]> {
    try {
      return await read();
    } catch (e) {
      if (NO_RECORD.has((e as { code?: string }).code ?? '')) return [];
      throw e;
    }
  }
}
