// codeshape: spec-only — the in-memory EdgeProvider that edge and tenant-domain specs drive
import { TenantDomainEdgeProvider } from '@prisma/client';

import { EdgeHostname, EdgeProvider } from './edge-provider';

/**
 * The port held in memory, for specs of whatever drives the edge lifecycle
 * (EDGE-1-e). Behaves as the port promises — one hostname per host, `null`
 * once removed — and `set` scripts what the provider reports next.
 */
export class FakeEdgeProvider implements EdgeProvider {
  readonly name = TenantDomainEdgeProvider.cloudflare;
  readonly hostnames = new Map<string, EdgeHostname>();
  private next = 1;

  async register(host: string): Promise<EdgeHostname> {
    const held = [...this.hostnames.values()].find((h) => h.host === host);
    if (held) return { ...held };
    const id = `fake-${this.next++}`;
    const hostname: EdgeHostname = {
      id,
      host,
      status: 'issuing',
      ownership: { type: 'TXT', name: `_cf-custom-hostname.${host}`, value: `owner-${id}` },
      errors: [],
    };
    this.hostnames.set(id, hostname);
    return { ...hostname };
  }

  async status(id: string): Promise<EdgeHostname | null> {
    const held = this.hostnames.get(id);
    return held ? { ...held } : null;
  }

  async remove(id: string): Promise<void> {
    this.hostnames.delete(id);
  }

  /** What the provider reports for `id` from now on. */
  set(id: string, change: Partial<Omit<EdgeHostname, 'id' | 'host'>>): void {
    const held = this.hostnames.get(id);
    if (!held) throw new Error(`no fake hostname ${id}`);
    this.hostnames.set(id, { ...held, ...change });
  }
}
