import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resolver } from 'node:dns/promises';

/** What a probe request came back with: an answer, or why there was none. */
export type ProbeAnswer = { status: number; body: unknown } | { error: string };

/**
 * The outside world a domain check reads: public DNS and the domain itself.
 * An interface so the state machine is tested against a scripted world.
 */
export interface DomainLookup {
  /** The TXT strings at `name` (chunks joined); `[]` when there are none. */
  txt(name: string): Promise<string[]>;
  /** The CNAME answers for `host`; `[]` when there are none. */
  cname(host: string): Promise<string[]>;
  /** One GET, redirects followed — a CDN sending http to https still serves a visitor. */
  probe(url: string): Promise<ProbeAnswer>;
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

  async probe(url: string): Promise<ProbeAnswer> {
    try {
      const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(this.timeoutMs) });
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
