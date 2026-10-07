import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DomainVerificationStatus,
  Prisma,
  TenantDomainEdgeStatus,
  TenantDomainPurpose,
  TenantDomainType,
  TenantType,
} from '@prisma/client';
import {
  AdmittedReseller,
  assertUnderLimit,
  RESELLER_LIMIT_USAGE,
  cnameTargetHost,
  normalizeHost,
  OutboxEventType,
  RequestHeaders,
  ResellerAccess,
  ResellerAccessRefused,
  ResellerAccessRejection,
  ResellerActor,
  resellerLimitOf,
  TenantCapabilityName,
  UnscopedRedisKeys,
} from '@txnet-backend/shared-core';
import { randomBytes } from 'node:crypto';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { RedisService } from '../redis/redis.service';
import {
  ADVISORY_LINES,
  CheckLine,
  DomainCheck,
  cacheLine,
  PROBE_PATH,
  cnameLine,
  edgeOwnerLine,
  probeLine,
  txtLine,
  verifyRecordName,
} from './domain-check';
import { DOMAIN_LOOKUP, DomainLookup } from './domain-lookup';
import { EDGE_PROVIDER, EdgeProvider, EdgeProviderError, EdgeRecord, edgeColumns } from './edge/edge-provider';
import type { AddDomainInput } from './tenant-domain.schema';

/**
 * A reseller proves a custom domain (F-018-i, catalog 13.2 steps 1-3 and 6).
 *
 * `pending` (a fresh token) → the tenant publishes the TXT record and asks for
 * a check → `verifying` → the sweep checks it every tick until it passes
 * (`verified`) or the window closes (`failed`). Every check stores what it
 * expected and what it found. A `verified` domain is re-checked — its TXT
 * record only — every `DOMAIN_REVALIDATE_EVERY_HOURS`; a missing record sets
 * `revalidatingSince`, the domain keeps routing through the grace, and then
 * drops to `pending` with its token kept.
 *
 * **Only `verified` routes** (tenant invariant 5) — which is why re-validation
 * is a column and not a status: every routing reader (`auth-service`'s
 * resolver, `billing-service`'s callback and return address) checks one value,
 * and a new one cannot forget a second.
 *
 * **A change of what routes retracts the host** (`contract.md`, ADR-0025 (4)):
 * `tenant:host:<host>` is deleted inside the transaction that writes it, so a
 * Redis that cannot be reached refuses the change rather than leaving the old
 * answer cached.
 *
 * **The edge (ADR-0129 (6), EDGE-1-e).** Once `verified`, the domain is
 * registered with the {@link EdgeProvider} and read every tick until its
 * certificate is `issued` or `failed`, then on the re-validation clock (renewal
 * is the provider's; `renew_failed` is read, never retried). A domain no
 * longer `verified` leaves the CDN. Live = `verified` and `issued`.
 *
 * **Every change of status writes `tenant.domain.changed`** in the transaction
 * that made it (RT-1-e, C-14), for the owner's page and the platform staff's.
 *
 * **Who.** {@link ResellerAccess}: the reseller the path names, reached by its
 * owner or the platform owner's staff (F-061-h). Only then is the cross-tenant
 * pool touched — a reseller's `tenant_domain` rows are not the caller's tenant's.
 */

export type DomainActor = ResellerActor;

/** The catalog's statuses as the tenant sees them; `revalidating` is `verified` inside its grace. */
export type DomainStatus = 'pending' | 'verifying' | 'verified' | 'revalidating' | 'failed';

export type DomainView = {
  id: string;
  domainValue: string;
  purpose: TenantDomainPurpose;
  status: DomainStatus;
  /** The record to publish at the tenant's own registrar. */
  record: { type: 'TXT'; name: string; value: string };
  /** Where the domain, or its CDN's origin, points (ADR-0060 (6)). */
  cnameTarget: string;
  verifiedAt: Date | null;
  lastCheckedAt: Date | null;
  lastCheck: DomainCheck | null;
  /**
   * The domain at the CDN (ADR-0129 (6)). `record` is the provider's ownership
   * TXT while it still asks for it: needed behind the reseller's own CDN, where
   * the edge answers 409 until it is published (EDGE-1-d).
   */
  edge: { status: TenantDomainEdgeStatus; record: EdgeRecord | null; lastError: string | null };
};

export type DomainSweep = {
  due: number;
  verified: number;
  waiting: number;
  failed: number;
  revalidated: number;
  revalidating: number;
  dropped: number;
  /** The edge pass (EDGE-1-e): registered this tick, issued, still issuing, failed, taken off the CDN. */
  edgeRegistered: number;
  edgeIssued: number;
  edgeWaiting: number;
  edgeFailed: number;
  edgeRemoved: number;
  errors: number;
};

type EdgeOutcome = 'edgeRegistered' | 'edgeIssued' | 'edgeWaiting' | 'edgeFailed' | 'edgeRemoved';
type SweepOutcome = Exclude<keyof DomainSweep, 'due' | 'errors' | EdgeOutcome>;

export type DomainRejection = ResellerAccessRejection | 'domain_not_found' | 'domain_taken' | 'domain_reserved';

export class DomainRefused extends Error {
  constructor(
    readonly reason: DomainRejection,
    detail = '',
  ) {
    super(`domain refused: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'DomainRefused';
  }
}

const DOMAIN_SELECT = {
  id: true,
  tenantId: true,
  domainType: true,
  domainValue: true,
  purpose: true,
  verificationStatus: true,
  verificationToken: true,
  statusChangedAt: true,
  verifiedAt: true,
  lastCheckedAt: true,
  lastCheck: true,
  revalidatingSince: true,
  edgeProvider: true,
  edgeHostnameId: true,
  edgeStatus: true,
  edgeCheckedAt: true,
  edgeLastError: true,
  edgeOwnershipName: true,
  edgeOwnershipValue: true,
  tenant: { select: { slug: true, ownerUserId: true } },
} satisfies Prisma.TenantDomainSelect;

type DomainRow = Prisma.TenantDomainGetPayload<{ select: typeof DOMAIN_SELECT }>;

/** A check the tenant asked for runs again only from these. */
const CHECKABLE: DomainVerificationStatus[] = [DomainVerificationStatus.pending, DomainVerificationStatus.failed];

/** Rows per tick; the oldest check first, so a backlog drains rather than starves. */
const SWEEP_BATCH = 50;

const HOUR_MS = 3_600_000;

/** Edge steps read every tick; the rest wait for the re-validation clock. */
const EDGE_MOVING: TenantDomainEdgeStatus[] = [TenantDomainEdgeStatus.none, TenantDomainEdgeStatus.registering, TenantDomainEdgeStatus.issuing];
const EDGE_SETTLED: TenantDomainEdgeStatus[] = [TenantDomainEdgeStatus.issued, TenantDomainEdgeStatus.renew_failed, TenantDomainEdgeStatus.failed];

/** The edge columns of a domain the CDN does not hold. */
const OFF_EDGE = {
  edgeProvider: null,
  edgeHostnameId: null,
  edgeStatus: TenantDomainEdgeStatus.none,
  edgeLastError: null,
  edgeOwnershipName: null,
  edgeOwnershipValue: null,
} satisfies Prisma.TenantDomainUpdateManyMutationInput;

@Injectable()
export class TenantDomainService {
  private readonly logger = new Logger(TenantDomainService.name);
  /** The platform owner's tenant, whose staff watch every reseller's domains. Never changes. */
  private platformTenantId: string | null = null;

  constructor(
    private readonly resellerAccess: ResellerAccess,
    private readonly all: CrossTenantPrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    @Inject(DOMAIN_LOOKUP) private readonly lookup: DomainLookup,
    @Inject(EDGE_PROVIDER) private readonly edge: EdgeProvider,
  ) {}

  async add(actor: DomainActor, tenantId: string, input: AddDomainInput, now = new Date()): Promise<DomainView> {
    const reseller = await this.access(actor, tenantId, 'staffWrite');
    const host = input.domainValue;
    const base = this.base();
    if (host === base || host.endsWith(`.${base}`)) throw new DomainRefused('domain_reserved', host);

    const existing = await this.all.tenantDomain.findUnique({ where: { domainValue: host }, select: DOMAIN_SELECT });
    if (existing?.tenantId === reseller.id && existing.domainType === TenantDomainType.custom_domain) return this.view(existing);
    // Proven first wins: a claim nobody proved blocks nobody, or a squatter
    // could hold a domain it does not own by never verifying it.
    if (existing && (existing.domainType === TenantDomainType.subdomain || existing.verificationStatus === DomainVerificationStatus.verified)) {
      throw new DomainRefused('domain_taken', host);
    }

    try {
      const row = await this.all.$transaction(async (tx) => {
        // Each custom domain is a certificate (F-019-q, ADR-0106): the reseller's
        // own people are bounded by its limit; the platform's staff are not.
        if (reseller.as !== 'staff') {
          const inEffect = await resellerLimitOf(tx, reseller.id, 'custom_domains_max');
          if (inEffect.limit !== null) {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`reseller_limit:custom_domains_max:${reseller.id}`}))`;
            const used = await RESELLER_LIMIT_USAGE.custom_domains_max(tx, reseller.id, new Date());
            assertUnderLimit('custom_domains_max', inEffect, used);
          }
        }
        if (existing) await tx.tenantDomain.delete({ where: { id: existing.id } });
        const created = await tx.tenantDomain.create({
          data: {
            tenantId: reseller.id,
            domainType: TenantDomainType.custom_domain,
            domainValue: host,
            purpose: input.purpose,
            verificationStatus: DomainVerificationStatus.pending,
            verificationToken: randomBytes(16).toString('hex'),
            statusChangedAt: now,
          },
          select: DOMAIN_SELECT,
        });
        // A cached *no tenant* for this host, or a replaced claimant's, goes with it.
        await this.redis.del(UnscopedRedisKeys.tenantByHost(host));
        return created;
      });
      this.logger.log(`custom domain ${host} added to ${reseller.id} by ${actor.userId}`);
      return this.view(row);
    } catch (e) {
      // Lost a race on `tenant_domain.domainValue`.
      if ((e as { code?: string })?.code === 'P2002') throw new DomainRefused('domain_taken', host);
      throw e;
    }
  }

  async list(actor: DomainActor, tenantId: string): Promise<DomainView[]> {
    const reseller = await this.access(actor, tenantId, 'read');
    const rows = await this.all.tenantDomain.findMany({
      where: { tenantId: reseller.id, domainType: TenantDomainType.custom_domain },
      orderBy: { domainValue: 'asc' },
      select: DOMAIN_SELECT,
    });
    return rows.map((r) => this.view(r));
  }

  /** Step 2: the tenant says the record is in place. Repeats safely. */
  async requestCheck(actor: DomainActor, tenantId: string, domainId: string, now = new Date()): Promise<DomainView> {
    const reseller = await this.access(actor, tenantId, 'staffWrite');
    const where = { id: domainId, tenantId: reseller.id, domainType: TenantDomainType.custom_domain };
    const row = await this.all.tenantDomain.findFirst({ where, select: DOMAIN_SELECT });
    if (!row) throw new DomainRefused('domain_not_found', domainId);
    if (CHECKABLE.includes(row.verificationStatus)) {
      await this.all.$transaction(async (tx) => {
        const { count } = await tx.tenantDomain.updateMany({
          where: { ...where, verificationStatus: row.verificationStatus },
          data: { verificationStatus: DomainVerificationStatus.verifying, statusChangedAt: now },
        });
        if (count > 0) await this.announce(tx, row);
      });
    } else if (row.verificationStatus === DomainVerificationStatus.verified && row.edgeStatus === TenantDomainEdgeStatus.failed) {
      // The edge gave up: start it over. The next tick removes the failed hostname and registers anew.
      await this.all.$transaction(async (tx) => {
        const { count } = await tx.tenantDomain.updateMany({
          where: { ...where, edgeStatus: TenantDomainEdgeStatus.failed },
          data: { edgeStatus: TenantDomainEdgeStatus.none, edgeLastError: null },
        });
        if (count > 0) await this.announce(tx, row);
      });
    }
    const current = await this.all.tenantDomain.findFirst({ where, select: DOMAIN_SELECT });
    return this.view(current ?? row);
  }

  /** Steps 3 and 6: every `verifying` domain, and every `verified` one whose re-validation is due. */
  async checkDue(now = new Date()): Promise<DomainSweep> {
    const every = this.hours('DOMAIN_REVALIDATE_EVERY_HOURS');
    const rows = await this.all.tenantDomain.findMany({
      where: {
        domainType: TenantDomainType.custom_domain,
        OR: [
          { verificationStatus: DomainVerificationStatus.verifying },
          {
            verificationStatus: DomainVerificationStatus.verified,
            // Inside its grace every tick: a restored record clears it and a lost one drops on time.
            OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lte: new Date(now.getTime() - every) } }, { revalidatingSince: { not: null } }],
          },
        ],
      },
      orderBy: { lastCheckedAt: { sort: 'asc', nulls: 'first' } },
      take: SWEEP_BATCH,
      select: DOMAIN_SELECT,
    });

    const sweep: DomainSweep = {
      due: rows.length,
      verified: 0,
      waiting: 0,
      failed: 0,
      revalidated: 0,
      revalidating: 0,
      dropped: 0,
      edgeRegistered: 0,
      edgeIssued: 0,
      edgeWaiting: 0,
      edgeFailed: 0,
      edgeRemoved: 0,
      errors: 0,
    };
    for (const row of rows) {
      try {
        sweep[await this.checkOne(row, now)] += 1;
      } catch (e) {
        sweep.errors += 1;
        this.logger.warn(`domain check of ${row.domainValue} failed: ${(e as Error).message}`);
      }
    }
    if (this.config.get<string>('EDGE_LIFECYCLE_ENABLED') === 'true') {
      // After the checks, so a domain verified this tick is registered this tick.
      for (const row of await this.edgeDue(now)) {
        try {
          sweep[await this.edgeOne(row, now)] += 1;
        } catch (e) {
          sweep.errors += 1;
          this.logger.warn(`edge step of ${row.domainValue} failed: ${(e as Error).message}`);
        }
      }
    }
    return sweep;
  }

  /**
   * The answer the http and https checks look for. Only on a host the
   * platform has a row for — any other gets the neutral 404 every unknown host
   * gets (F-1210). `host` is what the request arrived as, which is how a CDN
   * forwarding another reseller's target is caught.
   */
  async probeAnswer(rawHost: string | undefined, nonce: string): Promise<{ host: string; nonce: string } | null> {
    const host = normalizeHost(rawHost);
    if (!host) return null;
    const row = await this.all.tenantDomain.findUnique({ where: { domainValue: host }, select: { id: true } });
    return row ? { host, nonce } : null;
  }

  private async checkOne(row: DomainRow, now: Date): Promise<SweepOutcome> {
    const host = row.domainValue;
    const token = row.verificationToken ?? '';

    const target = cnameTargetHost(row.tenant.slug, this.base());
    if (row.verificationStatus === DomainVerificationStatus.verifying) {
      const cname = this.lookup.cname(host);
      const check = await this.check(now, [
        this.lookup.txt(verifyRecordName(host)).then((found) => txtLine(host, token, found)),
        cname.then((found) => cnameLine(target, this.base(), found)),
        ...(['http', 'https'] as const).map((scheme) => {
          const nonce = randomBytes(8).toString('hex');
          return this.lookup
            .probe(`${scheme}://${host}/${this.prefix()}/${PROBE_PATH}?n=${nonce}`)
            .then((answer) => probeLine(scheme, host, target, nonce, answer));
        }),
        this.cacheCheck(host),
        ...this.edgeLines(row, target, cname),
      ]);
      if (check.ok) {
        await this.write(row, now, check, {
          verificationStatus: DomainVerificationStatus.verified,
          verifiedAt: now,
          lastRevalidatedAt: now,
          revalidatingSince: null,
          statusChangedAt: now,
        }, true);
        return 'verified';
      }
      const expired = now.getTime() - (row.statusChangedAt ?? now).getTime() >= this.hours('DOMAIN_VERIFY_WINDOW_HOURS');
      await this.write(row, now, check, expired ? { verificationStatus: DomainVerificationStatus.failed, statusChangedAt: now } : {}, false);
      return expired ? 'failed' : 'waiting';
    }

    // `verified`: catalog 13.2 step 6 re-validates the record, not the path —
    // a CDN outage is not a lost domain.
    const check = await this.check(now, [
      this.lookup.txt(verifyRecordName(host)).then((found) => txtLine(host, token, found)),
      ...this.edgeLines(row, target),
    ]);
    if (check.ok) {
      await this.write(row, now, check, { lastRevalidatedAt: now, revalidatingSince: null }, false);
      return 'revalidated';
    }
    if (!row.revalidatingSince) {
      await this.write(row, now, check, { revalidatingSince: now }, false);
      return 'revalidating';
    }
    if (now.getTime() - row.revalidatingSince.getTime() < this.hours('DOMAIN_REVALIDATION_GRACE_HOURS')) {
      await this.write(row, now, check, {}, false);
      return 'revalidating';
    }
    await this.write(row, now, check, {
      verificationStatus: DomainVerificationStatus.pending,
      verifiedAt: null,
      revalidatingSince: null,
      statusChangedAt: now,
    }, true);
    this.logger.log(`custom domain ${host} of ${row.tenantId} lost its record: back to pending, no longer routed`);
    return 'dropped';
  }

  /** Two requests to one URL, one after the other, each with its own nonce (ADR-0129 (8)). */
  private async cacheCheck(host: string): Promise<CheckLine> {
    const url = `https://${host}/${this.prefix()}/${PROBE_PATH}`;
    const nonces: [string, string] = [randomBytes(8).toString('hex'), randomBytes(8).toString('hex')];
    const first = await this.lookup.probe(url, { [RequestHeaders.domainProbe]: nonces[0] });
    const second = await this.lookup.probe(url, { [RequestHeaders.domainProbe]: nonces[1] });
    return cacheLine(nonces, [first, second]);
  }

  /**
   * The domains the edge owes a step: verified ones not yet issued (every
   * tick) or settled and due again on the re-validation clock, and any domain
   * no longer verified that the CDN still holds.
   */
  private async edgeDue(now: Date): Promise<DomainRow[]> {
    const every = this.hours('DOMAIN_REVALIDATE_EVERY_HOURS');
    return this.all.tenantDomain.findMany({
      where: {
        domainType: TenantDomainType.custom_domain,
        OR: [
          { verificationStatus: DomainVerificationStatus.verified, edgeStatus: { in: EDGE_MOVING } },
          {
            verificationStatus: DomainVerificationStatus.verified,
            edgeStatus: { in: EDGE_SETTLED },
            OR: [{ edgeCheckedAt: null }, { edgeCheckedAt: { lte: new Date(now.getTime() - every) } }],
          },
          { verificationStatus: { not: DomainVerificationStatus.verified }, edgeHostnameId: { not: null } },
        ],
      },
      orderBy: { edgeCheckedAt: { sort: 'asc', nulls: 'first' } },
      take: SWEEP_BATCH,
      select: DOMAIN_SELECT,
    });
  }

  /** One domain's next edge step. Every write is guarded on the edge step it read. */
  private async edgeOne(row: DomainRow, now: Date): Promise<EdgeOutcome> {
    const id = row.edgeHostnameId;
    if (row.verificationStatus !== DomainVerificationStatus.verified) {
      await this.edge.remove(id!);
      await this.edgeWrite(row, { ...OFF_EDGE, edgeCheckedAt: now });
      this.logger.log(`custom domain ${row.domainValue} is no longer verified: taken off the edge`);
      return 'edgeRemoved';
    }

    if (id && row.edgeStatus !== TenantDomainEdgeStatus.none && row.edgeStatus !== TenantDomainEdgeStatus.registering) {
      const hostname = await this.edge.status(id);
      // Gone at the provider: our table is the list, so it is registered again next tick.
      if (!hostname) {
        await this.edgeWrite(row, { ...OFF_EDGE, edgeCheckedAt: now });
        return 'edgeWaiting';
      }
      await this.edgeWrite(row, edgeColumns(this.edge.name, hostname, now));
      return hostname.status === 'issued' ? 'edgeIssued' : hostname.status === 'failed' ? 'edgeFailed' : 'edgeWaiting';
    }

    // `none` (a retry removes the hostname that failed first) or a `registering` that did not land.
    if (id && row.edgeStatus === TenantDomainEdgeStatus.none) await this.edge.remove(id);
    let current = row;
    if (row.edgeStatus === TenantDomainEdgeStatus.none) {
      if (!(await this.edgeWrite(row, { edgeStatus: TenantDomainEdgeStatus.registering, edgeHostnameId: null, edgeCheckedAt: now }))) return 'edgeWaiting';
      current = { ...row, edgeStatus: TenantDomainEdgeStatus.registering, edgeHostnameId: null };
    }
    try {
      const hostname = await this.edge.register(row.domainValue);
      await this.edgeWrite(current, edgeColumns(this.edge.name, hostname, now));
      return hostname.status === 'failed' ? 'edgeFailed' : 'edgeRegistered';
    } catch (e) {
      // Kept for the page, and `registering` is tried again next tick.
      if (e instanceof EdgeProviderError) await this.edgeWrite(current, { edgeLastError: e.detail, edgeCheckedAt: now });
      throw e;
    }
  }

  /** An edge write, guarded on the step it read; announced when the step changed. */
  private async edgeWrite(row: DomainRow, data: Prisma.TenantDomainUpdateManyMutationInput): Promise<boolean> {
    return this.all.$transaction(async (tx) => {
      const { count } = await tx.tenantDomain.updateMany({
        where: { id: row.id, verificationStatus: row.verificationStatus, edgeStatus: row.edgeStatus },
        data,
      });
      if (count > 0 && data.edgeStatus !== undefined && data.edgeStatus !== row.edgeStatus) await this.announce(tx, row);
      return count > 0;
    });
  }

  /**
   * `tenant.domain.changed` (RT-1-e): the reseller's owner hears it on their
   * own channel and the platform's staff on the platform's `tenant:` channel —
   * the page is on the platform's panel (`/my-resellers/:id/domains`), so the
   * reseller's own `tenant:` channel reaches nobody looking at it. Ids only.
   */
  private async announce(tx: Prisma.TransactionClient, row: DomainRow): Promise<void> {
    this.platformTenantId ??=
      (await tx.tenant.findFirst({ where: { tenantType: TenantType.platform_owner }, select: { id: true } }))?.id ?? null;
    if (!this.platformTenantId) throw new Error('no platform_owner tenant');
    await tx.outboxEvent.create({
      data: {
        aggregate: 'tenant.domain',
        aggregateId: row.id,
        type: OutboxEventType.TENANT_DOMAIN_CHANGED,
        payload: { tenantId: this.platformTenantId, userId: row.tenant.ownerUserId, resellerId: row.tenantId, domainId: row.id },
      },
      select: { id: true },
    });
  }

  /** `ok` is the domain's own proof; an advisory line is shown, never decisive. */
  private async check(now: Date, lines: Promise<CheckLine>[]): Promise<DomainCheck> {
    const done = await Promise.all(lines);
    return { at: now.toISOString(), ok: done.every((l) => l.ok || ADVISORY_LINES.has(l.check)), lines: done };
  }

  /** The edge's ownership record, read while the provider asks for one (EDGE-1-d). */
  private edgeLines(row: DomainRow, target: string, cname?: Promise<string[]>): Promise<CheckLine>[] {
    const name = row.edgeOwnershipName;
    const value = row.edgeOwnershipValue;
    if (!name || !value) return [];
    const found = cname ?? this.lookup.cname(row.domainValue);
    return [Promise.all([this.lookup.txt(name), found]).then(([txt, names]) => edgeOwnerLine({ name, value }, target, txt, names))];
  }

  /**
   * One row's outcome, guarded on the status it was read in: a row claimed or
   * re-requested meanwhile is left alone. `retract` when what routes changed.
   */
  private async write(
    row: DomainRow,
    now: Date,
    check: DomainCheck,
    data: Prisma.TenantDomainUpdateManyMutationInput,
    retract: boolean,
  ): Promise<void> {
    await this.all.$transaction(async (tx) => {
      const { count } = await tx.tenantDomain.updateMany({
        where: { id: row.id, verificationStatus: row.verificationStatus },
        data: { ...data, lastCheckedAt: now, lastCheck: check as unknown as Prisma.InputJsonValue },
      });
      if (count > 0 && retract) await this.redis.del(UnscopedRedisKeys.tenantByHost(row.domainValue));
      if (count > 0 && statusOf({ ...row, ...data } as DomainRow) !== statusOf(row)) await this.announce(tx, row);
    });
  }

  /** The one access check (F-061-h); nothing on the cross-tenant pool is read before it. */
  private async access(actor: DomainActor, tenantId: string, capability: TenantCapabilityName): Promise<AdmittedReseller> {
    try {
      return await this.resellerAccess.admit(actor, tenantId, capability);
    } catch (e) {
      if (e instanceof ResellerAccessRefused) throw new DomainRefused(e.reason, tenantId);
      throw e;
    }
  }

  private view(row: DomainRow): DomainView {
    const status = statusOf(row);
    return {
      id: row.id,
      domainValue: row.domainValue,
      purpose: row.purpose,
      status,
      record: { type: 'TXT', name: verifyRecordName(row.domainValue), value: row.verificationToken ?? '' },
      cnameTarget: cnameTargetHost(row.tenant.slug, this.base()),
      verifiedAt: row.verifiedAt,
      lastCheckedAt: row.lastCheckedAt,
      lastCheck: (row.lastCheck as unknown as DomainCheck | null) ?? null,
      edge: {
        status: row.edgeStatus,
        record:
          row.edgeOwnershipName && row.edgeOwnershipValue
            ? { type: 'TXT', name: row.edgeOwnershipName, value: row.edgeOwnershipValue }
            : null,
        lastError: row.edgeLastError,
      },
    };
  }

  private base(): string {
    return String(this.config.get<string>('DOMAIN_NAME')).toLowerCase();
  }

  private prefix(): string {
    return this.config.get<string>('GLOBAL_PREFIX') ?? 'api';
  }

  private hours(key: string): number {
    return Number(this.config.get<number>(key)) * HOUR_MS;
  }
}

/** The status the tenant sees: `revalidating` is `verified` inside its grace. */
function statusOf(row: Pick<DomainRow, 'verificationStatus' | 'revalidatingSince'>): DomainStatus {
  return row.verificationStatus === DomainVerificationStatus.verified && row.revalidatingSince ? 'revalidating' : row.verificationStatus;
}
