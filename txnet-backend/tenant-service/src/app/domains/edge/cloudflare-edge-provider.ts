import { TenantDomainEdgeProvider } from '@prisma/client';

import { EdgeHostname, EdgeHostnameStatus, EdgeProvider, EdgeProviderError } from './edge-provider';

/**
 * Cloudflare for SaaS (ADR-0129 (1, 3)): every reseller domain is a Custom
 * Hostname on the platform zone, with its own DV certificate validated over
 * HTTP once the domain CNAMEs to `<slug>.edge.<domain>` — or reaches it
 * through the reseller's own CDN, which then needs the ownership TXT
 * (EDGE-1-a, contract.domains.md).
 *
 * The token is scoped to the one zone (SSL and Certificates: Edit). Proven on
 * `txnet.cyou` with `edgetest.chillshop.ir`, 2026-10-07.
 */

const API = 'https://api.cloudflare.com/client/v4';

/** Cloudflare's code for registering a hostname the zone already has. */
const DUPLICATE_HOSTNAME = 1406;

/** Hostname states that will never serve without someone acting. */
const HOSTNAME_FAILED = new Set(['blocked', 'moved', 'deleted']);
/** Certificate states Cloudflare gave up on. */
const CERTIFICATE_FAILED = new Set(['validation_timed_out', 'issuance_timed_out', 'deleted']);
/** A certificate that was issued and is serving; `pending_expiration` is its renewal under way. */
const CERTIFICATE_SERVING = new Set(['active', 'pending_expiration']);

type CfHostname = {
  id: string;
  hostname: string;
  status: string;
  verification_errors?: string[];
  ownership_verification?: { type?: string; name?: string; value?: string };
  ssl?: { status?: string; validation_errors?: Array<{ message?: string }> };
};

type CfEnvelope<T> = { success?: boolean; errors?: Array<{ code?: number; message?: string }>; result?: T };

class CfRefused extends Error {
  constructor(
    readonly status: number,
    readonly codes: number[],
    detail: string,
  ) {
    super(detail);
  }
}

export class CloudflareEdgeProvider implements EdgeProvider {
  readonly name = TenantDomainEdgeProvider.cloudflare;

  constructor(
    private readonly token: string,
    private readonly zoneId: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 15_000,
  ) {}

  async register(host: string): Promise<EdgeHostname> {
    return this.call('register', async () => {
      try {
        return toHostname(
          await this.request<CfHostname>('POST', '', {
            hostname: host,
            ssl: { method: 'http', type: 'dv', settings: { min_tls_version: '1.2' } },
          }),
        );
      } catch (e) {
        if (!(e instanceof CfRefused) || !e.codes.includes(DUPLICATE_HOSTNAME)) throw e;
        // Ours already: the table is re-sent, never doubled (ADR-0129 (5)).
        const [held] = await this.request<CfHostname[]>('GET', `?hostname=${encodeURIComponent(host)}`);
        if (!held) throw e;
        return toHostname(held);
      }
    });
  }

  async status(id: string): Promise<EdgeHostname | null> {
    return this.call('status', async () => {
      try {
        return toHostname(await this.request<CfHostname>('GET', `/${encodeURIComponent(id)}`));
      } catch (e) {
        if (e instanceof CfRefused && e.status === 404) return null;
        throw e;
      }
    });
  }

  async remove(id: string): Promise<void> {
    return this.call('remove', async () => {
      try {
        await this.request<unknown>('DELETE', `/${encodeURIComponent(id)}`);
      } catch (e) {
        if (!(e instanceof CfRefused && e.status === 404)) throw e;
      }
    });
  }

  private async call<T>(operation: EdgeProviderError['operation'], run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      if (e instanceof EdgeProviderError) throw e;
      const cause = (e as { cause?: { code?: string } }).cause?.code;
      throw new EdgeProviderError(operation, cause ?? (e as Error).message ?? 'error');
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetchImpl(`${API}/zones/${this.zoneId}/custom_hostnames${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    let envelope: CfEnvelope<T> = {};
    try {
      envelope = (await response.json()) as CfEnvelope<T>;
    } catch {
      // Not Cloudflare's JSON (a proxy's page): the status alone is the detail.
    }
    if (!response.ok || envelope.success === false) {
      const errors = envelope.errors ?? [];
      const said = errors.map((err) => `${err.code ?? ''} ${err.message ?? ''}`.trim()).join('; ');
      throw new CfRefused(response.status, errors.map((err) => err.code ?? 0), `${response.status}${said ? ` ${said}` : ''}`);
    }
    return envelope.result as T;
  }
}

function toHostname(cf: CfHostname): EdgeHostname {
  const own = cf.ownership_verification;
  return {
    id: cf.id,
    host: cf.hostname,
    status: statusOf(cf),
    ownership: own?.name && own.value ? { type: 'TXT', name: own.name, value: own.value } : null,
    errors: [
      ...(cf.verification_errors ?? []),
      ...(cf.ssl?.validation_errors ?? []).flatMap((err) => (err.message ? [err.message] : [])),
    ],
  };
}

function statusOf(cf: CfHostname): EdgeHostnameStatus {
  const ssl = cf.ssl?.status ?? '';
  if (HOSTNAME_FAILED.has(cf.status) || CERTIFICATE_FAILED.has(ssl)) return 'failed';
  if (ssl === 'expired') return 'renew_failed';
  return cf.status === 'active' && CERTIFICATE_SERVING.has(ssl) ? 'issued' : 'issuing';
}
