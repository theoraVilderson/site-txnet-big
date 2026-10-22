import { Injectable } from '@nestjs/common';
import { DomainVerificationStatus, GrantStatus, TenantDomainPurpose } from '@prisma/client';
import { normalizeHost, ResellerAccess, tenantTransaction, type ResellerActor } from '@txnet-backend/shared-core';

import { PrismaService } from '../prisma/prisma.service';
import { admitMigration } from './migration-door';
import { MigrationRunRefused } from './migration-run';
import { snapshotLabel } from './migration-run-view';
import { MigrationSeamRefused, MigrationSeamUnavailable, SubscriptionLinkProbe } from './migration-seams';

/** At most this many old hosts are listed: an import has one or two; this bounds a hostile source (C-28). */
const MAX_LEGACY_HOSTS = 20;

/** Why a test could not be run on our side, as a test result: network-service did not answer. */
const PROBE_UNAVAILABLE = 'probe_unavailable';

/** An old panel's subscription host the reseller's imported users hold links on, and how many (F-203-a). */
export type LegacyHostView = { host: string; links: number };

/** One imported link fetched from outside: the servers it carried, or the reason it did not answer (network's refusal). */
export type LegacyTestResult = { host: string; label: string | null } & ({ outcome: 'ok'; servers: number } | { outcome: 'failed'; reason: string });

/**
 * The URL an app fetches for a kept link: the path is stored decoded
 * (`legacyPathOf`), so it is escaped again here. Always https: the old host
 * is served with the edge's certificate once it points here (ADR-0129).
 */
export function legacyLinkUrl(host: string, path: string): string {
  const url = new URL(`https://${host}`);
  url.pathname = path.replace(/[?#]/g, encodeURIComponent);
  return url.toString();
}

/**
 * The import page's last step (F-204-b, D-63): which old hosts the reseller
 * must point here, and a test of one imported user's old link once a host
 * does. Under the import's door, `migration.manage`, read capability — the
 * test changes nothing.
 */
@Injectable()
export class LegacyHostService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ResellerAccess,
    private readonly probe: SubscriptionLinkProbe,
  ) {}

  /** The reseller's old hosts with their kept links, most first — tenant-wide: two imports of one old panel share a host. */
  hosts(actor: ResellerActor, tenantId: string): Promise<{ hosts: LegacyHostView[] }> {
    return admitMigration(this.access, { actor, tenantId, capability: 'read' }, () =>
      tenantTransaction(this.prisma, async (tx) => {
        const rows = await tx.legacySubLink.groupBy({
          by: ['host'],
          where: { tenantId },
          _count: { _all: true },
          orderBy: { _count: { host: 'desc' } },
          take: MAX_LEGACY_HOSTS,
        });
        return { hosts: rows.map((r) => ({ host: r.host, links: r._count._all })) };
      }),
    );
  }

  /**
   * Fetches one kept link on `host` from outside, as the user's app would.
   * Only a host the reseller proved (`legacy_sub`, `verified`): the host came
   * from the source, which is adversarial input (catalog §16), and an
   * unproved one may still be the old panel, answering for a link we do not
   * serve. The sample's Grant is not cancelled — sub-service answers that
   * one a 404 by rule (sub-api F-203-b rule 2).
   */
  test(actor: ResellerActor, tenantId: string, rawHost: string): Promise<LegacyTestResult> {
    const host = normalizeHost(rawHost);
    return admitMigration(this.access, { actor, tenantId, capability: 'read' }, async () => {
      const sample = await tenantTransaction(this.prisma, async (tx) => {
        const routed = await tx.tenantDomain.findFirst({
          where: { tenantId, domainValue: host, purpose: TenantDomainPurpose.legacy_sub, verificationStatus: DomainVerificationStatus.verified },
          select: { id: true },
        });
        if (!routed) throw new MigrationRunRefused('legacy_host_not_routed', host);
        const link = await tx.legacySubLink.findFirst({
          where: { tenantId, host, grant: { status: { not: GrantStatus.cancelled } } },
          orderBy: { createdAt: 'asc' },
          select: { path: true, migrationItemId: true },
        });
        if (!link) throw new MigrationRunRefused('legacy_link_not_found', host);
        const item = await tx.migrationItem.findFirst({ where: { id: link.migrationItemId, tenantId }, select: { sourceSnapshot: true } });
        return { path: link.path, label: snapshotLabel(item?.sourceSnapshot ?? null) || null };
      });
      // Outside the transaction: an outside fetch of up to 30 s holds no connection.
      return this.fetch(host, sample);
    });
  }

  private async fetch(host: string, sample: { path: string; label: string | null }): Promise<LegacyTestResult> {
    const at = { host, label: sample.label };
    try {
      return { ...at, outcome: 'ok', servers: await this.probe.servers(legacyLinkUrl(host, sample.path)) };
    } catch (e) {
      if (e instanceof MigrationSeamRefused) return { ...at, outcome: 'failed', reason: e.reason };
      if (e instanceof MigrationSeamUnavailable) return { ...at, outcome: 'failed', reason: PROBE_UNAVAILABLE };
      throw e;
    }
  }
}
