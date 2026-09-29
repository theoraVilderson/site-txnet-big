import { Injectable, Logger } from '@nestjs/common';
import { HoldReason, Prisma, UsageDispositionState } from '@prisma/client';
import {
  endNoticeStep,
  heldUsageNotice,
  idleCheckOf,
  remainingLabel,
  retentionEvent,
  retentionToTell,
  OutboxEventType,
  recordUsage,
  runWithTenant,
  tenantTransaction,
  USAGE_DELTA_MESSAGE_VERSION,
  UsageRefused,
  usageReleaseDeltaId,
  type UsageDeltaMessage,
  type UsageEvent,
  type UsageRecorded,
  type UsageDeltaRow,
  type UsageQuarantineRow,
  type UsageReleasePayload,
  type UsageUnattributedRow,
} from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { SubUsagePublisher } from './sub-usage.publisher';
import { usageThresholdCrossed, type UsageThresholdGrant } from './usage-threshold';

/** How often a Grant's owner is told its total, at most (F-307-t; user, 2026-09-27). */
export const USAGE_PUSH_EVERY_MS = 30_000;

/** What one pass became. Every figure the message carried is in exactly one of these. */
export interface MeteringOutcome {
  applied: number;
  held: number;
  quarantined: number;
  unattributed: number;
  duplicates: number;
}

/**
 * A pass published under a version this consumer was not written against.
 *
 * Thrown rather than skipped: the fields it carries are not the fields below,
 * and a consumer that guesses produces a wrong number instead of an error. The
 * message dead-letters, which is where a deploy-order mistake belongs.
 */
export class UnsupportedDeltaVersion extends Error {
  constructor(readonly version: number) {
    super(`usage delta message version ${version} — this consumer reads ${USAGE_DELTA_MESSAGE_VERSION}`);
    this.name = 'UnsupportedDeltaVersion';
  }
}

/** A release names a hold this platform does not hold. Thrown so the message dead-letters as evidence. */
export class UnknownHold extends Error {
  constructor(readonly holdId: string) {
    super(`usage hold ${holdId} does not exist`);
    this.name = 'UnknownHold';
  }
}

/** The hold was released or written off before this release reached it. Rolls the transaction back. */
class HoldAlreadyResolved extends Error {}

/**
 * The delta consumer (F-027-n) — where a collection pass stops being a message
 * and becomes usage.
 *
 * **Exactly-once effect over at-least-once delivery.** The broker redelivers
 * (ADR-0027) and `deltaId` is derived from the delta rather than generated
 * (`contracts/network/delta.json`), so the second delivery of a delta carries
 * the id the first one did. Each delta is applied in its own transaction that
 * inserts `usage_delta_seen` beside the write it authorises: the insert is the
 * deduplication (network invariant 19), and a unique violation is absorbed as
 * "already applied" rather than retried. The pre-read below only saves the
 * transactions; it is not what makes this safe, and the spec defeats it on
 * purpose to prove that.
 *
 * **Every measured byte lands somewhere** (network invariant 18). A delta is
 * billed, held or written down, and the pass's own quarantine and unattributed
 * streams are stored as they arrive:
 *
 * | what arrived | where it lands |
 * |---|---|
 * | a delta whose config claims that remote client | `traffic_raw_log` + `grant.consumedBytes` |
 * | a delta whose config claims a *different* remote client | `usage_hold`, `attribution_ambiguous` |
 * | a delta naming a config this platform does not have | `unattributed_usage`, against the panel's own identifier |
 * | the pass's `quarantines` | `usage_delta_quarantine`, as the collector judged them |
 * | the pass's `unattributed` | `unattributed_usage` |
 *
 * Usage is *visible* here and nobody pays yet: `consumedBytes` is the measured
 * cursor and is deliberately not the meter's `billed` (entitlement/data-model.md).
 *
 * **Two pools, for the reason `billing-service` gives.** `traffic_raw_log` and
 * `grant` carry RLS policies keyed on `app.tenant_id` (F-027-ak), and neither
 * model is in `TENANT_SCOPED_MODELS`, so nothing binds that setting on their
 * behalf — {@link tenantTransaction} does it as the transaction's first
 * statement. The tenant itself comes from the `config` row, and *that* read
 * cannot be scoped: a platform-owned panel's message carries no `tenantId` at
 * all, so the read that produces the scope runs on the cross-tenant pool.
 *
 * **After a charge commits, the Grant's new total goes to Redis** for `/sub`
 * (F-609-a) through {@link SubUsagePublisher}, which never throws: the write is
 * outside the transaction and can never undo or retry it.
 */
@Injectable()
export class MeteringService {
  private readonly logger = new Logger(MeteringService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crossTenant: CrossTenantPrismaService,
    private readonly subUsage: SubUsagePublisher,
  ) {}

  async apply(message: UsageDeltaMessage): Promise<MeteringOutcome> {
    if (message.version !== USAGE_DELTA_MESSAGE_VERSION) {
      throw new UnsupportedDeltaVersion(message.version);
    }

    const outcome: MeteringOutcome = { applied: 0, held: 0, quarantined: 0, unattributed: 0, duplicates: 0 };

    const configs = await this.configsOf(message.deltas);
    const alreadySeen = await this.seenOf(message.deltas);

    for (const delta of message.deltas) {
      if (alreadySeen.has(delta.deltaId)) {
        outcome.duplicates += 1;
        continue;
      }
      const config = configs.get(delta.configId);
      if (!config) {
        // Not a failure of ours to look up: the collector attributed a remote
        // client to a config id this platform does not hold. The bytes are
        // real and belong to the panel's own identifier until someone places
        // them (invariant 25).
        if (await this.writeDown(message.panelId, delta.remoteId, delta)) outcome.unattributed += 1;
        continue;
      }
      if (config.remoteId !== null && config.remoteId !== delta.remoteId) {
        // The message carries `remoteId` beside `configId` exactly so a wrong
        // attribution is visible in the message that made it. Believed bytes,
        // unbillable until the disagreement is resolved (ADR-0074).
        if (await this.hold(message.panelId, config, delta)) outcome.held += 1;
        else outcome.duplicates += 1;
        continue;
      }
      if (await this.bill(message.panelId, config, delta)) outcome.applied += 1;
      else outcome.duplicates += 1;
    }

    outcome.quarantined = await this.quarantine(message.panelId, message.quarantines);
    for (const row of message.unattributed) {
      if (await this.writeDown(message.panelId, row.remoteIdentifier, row)) outcome.unattributed += 1;
    }

    this.logger.log(
      `panel ${message.panelId} chunk ${message.chunk}/${message.chunks}: ` +
        `${outcome.applied} billed, ${outcome.held} held, ${outcome.quarantined} quarantined, ` +
        `${outcome.unattributed} unattributed, ${outcome.duplicates} already seen`,
    );
    return outcome;
  }

  /**
   * A released hold (F-027-at, ADR-0080 decision 3), billed as a delta.
   *
   * The figure is the hold row's, never the message's. One transaction flips
   * the hold `pending -> released` **conditionally**, inserts the seen row
   * under {@link usageReleaseDeltaId}, and bills through {@link charge} — the
   * same writes a collected delta makes. A hold that is no longer pending
   * (released by an earlier copy, or written off after the release was
   * queued) is `already_resolved` and nothing is billed; the seen row is the
   * backstop behind the flip, as it is behind the pre-read in {@link apply}.
   */
  async release(release: UsageReleasePayload): Promise<'released' | 'already_resolved'> {
    // Cross-tenant for the reason `configsOf` is: this read produces the tenant.
    const hold = await this.crossTenant.usageHold.findUnique({
      where: { id: release.holdId },
      select: {
        id: true, configId: true, panelId: true, upBytes: true, downBytes: true, heldFrom: true, state: true,
        config: { select: { tenantId: true, grantId: true } },
      },
    });
    if (!hold) throw new UnknownHold(release.holdId);
    if (hold.state !== UsageDispositionState.pending) return 'already_resolved';

    let total: bigint | undefined;
    try {
      const applied = await this.onceUnder(hold.config.tenantId, async (tx) => {
        const { count } = await tx.usageHold.updateMany({
          where: { id: hold.id, state: UsageDispositionState.pending },
          data: {
            state: UsageDispositionState.released,
            resolvedAt: new Date(),
            resolvedByAdminId: release.adminId,
            resolutionNote: release.note,
          },
        });
        if (count === 0) throw new HoldAlreadyResolved();
        total = await this.charge(tx, {
          deltaId: usageReleaseDeltaId(hold.id),
          panelId: hold.panelId,
          config: { id: hold.configId, tenantId: hold.config.tenantId, grantId: hold.config.grantId },
          up: hold.upBytes,
          down: hold.downBytes,
          observedAt: hold.heldFrom,
        });
      });
      if (!applied) return 'already_resolved';
    } catch (err) {
      if (err instanceof HoldAlreadyResolved) return 'already_resolved';
      throw err;
    }
    if (total !== undefined) await this.subUsage.publish(hold.config.grantId, total);
    this.logger.log(`hold ${hold.id} released by ${release.adminId}: ${hold.upBytes + hold.downBytes} bytes billed`);
    return 'released';
  }

  /**
   * One queued usage event (F-118-f, ADR-0105 decision 5): the meter's
   * tenant is read across tenants — as `configsOf` produces a delta's — and
   * {@link recordUsage} runs under it. A duplicate is an answer and acks; a
   * refusal throws, so the message dead-letters as the evidence of what a
   * reporter claimed.
   */
  async intake(event: UsageEvent): Promise<UsageRecorded> {
    const meter = await this.crossTenant.grantMeter.findUnique({
      where: { grantId_meterKey: { grantId: event.grantId, meterKey: event.meterKey } },
      select: { tenantId: true },
    });
    if (!meter) throw new UsageRefused('meter_not_on_grant');
    return runWithTenant({ id: meter.tenantId }, async () =>
      await tenantTransaction(this.prisma, (tx) => recordUsage(tx, event)),
    );
  }

  /**
   * The configs the pass names, read across tenants.
   *
   * The audit `CrossTenantPrismaService` asks for: this read *produces* the
   * tenant every write below is scoped by, and a message about a
   * platform-owned panel carries none, so it cannot itself run under one. It
   * selects four columns and no usage.
   */
  private async configsOf(deltas: UsageDeltaRow[]) {
    const ids = [...new Set(deltas.map((d) => d.configId))];
    if (ids.length === 0) return new Map<string, ConfigAttribution>();
    const rows = await this.crossTenant.config.findMany({
      where: { id: { in: ids } },
      select: { id: true, tenantId: true, grantId: true, remoteId: true },
    });
    return new Map(rows.map((row) => [row.id, row as ConfigAttribution]));
  }

  /** Which of this pass's deltas were already applied. An optimisation, never the guard. */
  private async seenOf(deltas: UsageDeltaRow[]) {
    const ids = deltas.map((d) => d.deltaId);
    if (ids.length === 0) return new Set<string>();
    const rows = await this.prisma.usageDeltaSeen.findMany({
      where: { deltaId: { in: ids } },
      select: { deltaId: true },
    });
    return new Set(rows.map((row) => row.deltaId));
  }

  /**
   * Bill one delta. `false` means the unique index said it was already applied.
   * The Grant's total is published only once the transaction has committed.
   */
  private async bill(panelId: string, config: ConfigAttribution, delta: UsageDeltaRow): Promise<boolean> {
    let total = 0n;
    const applied = await this.onceUnder(config.tenantId, async (tx) => {
      total = await this.charge(tx, {
        deltaId: delta.deltaId,
        panelId,
        config,
        up: BigInt(delta.upBytes),
        down: BigInt(delta.downBytes),
        observedAt: new Date(delta.observedAt),
      });
    });
    if (applied) await this.subUsage.publish(config.grantId, total);
    return applied;
  }

  /**
   * The one path that writes consumption: the seen row, the raw log and the
   * Grant cursor. A collected delta and a released hold both come through
   * here, so a release cannot skip a rule the normal path holds (ADR-0080).
   * Returns the Grant's `consumedBytes` as this transaction left it.
   */
  private async charge(
    tx: Prisma.TransactionClient,
    c: { deltaId: string; panelId: string; config: Omit<ConfigAttribution, 'remoteId'>; up: bigint; down: bigint; observedAt: Date },
  ): Promise<bigint> {
    await tx.usageDeltaSeen.create({
      data: { deltaId: c.deltaId, configId: c.config.id, panelId: c.panelId, upBytes: c.up, downBytes: c.down, observedAt: c.observedAt },
    });
    await tx.trafficRawLog.create({
      data: { tenantId: c.config.tenantId, configId: c.config.id, uploadBytes: c.up, downloadBytes: c.down, recordedAt: c.observedAt },
    });
    const charged = c.up + c.down;
    const grant = await tx.grant.update({
      where: { id: c.config.grantId },
      // A consumed byte restarts the "trouble connecting?" clock (F-601-l):
      // processing time, not `observedAt`, so a hold released late never moves it back.
      data: { consumedBytes: { increment: charged }, ...(charged > 0n ? { idleCheckAt: idleCheckOf(new Date()) } : {}) },
      select: {
        consumedBytes: true,
        userId: true,
        status: true,
        billingMode: true,
        trafficUnlimited: true,
        purchasedBytes: true,
        usagePeriodFromBytes: true,
        usagePeriodStartedAt: true,
        startsAt: true,
        activatedAt: true,
        endSetAt: true,
        endsAt: true,
        endNoticeFor: true,
        endNoticeAt: true,
        usageNoticeLevel: true,
        usageNoticeSince: true,
      },
    });
    await this.announceUsage(tx, c.config, grant.userId, grant.consumedBytes);
    await this.announceThreshold(tx, c.config, grant, charged);
    return grant.consumedBytes;
  }

  /**
   * A charge that crossed 50 / 80 / 95 % of a prepaid Grant's period (F-601-d)
   * tells it — or holds it (F-601-n) — in this transaction: it commits with
   * the bytes that crossed it, and the Grant row the update holds locked
   * orders two replicas' charges, so exactly one of them sees each crossing.
   *
   * **Two due the same day are one message.** A time level already due and
   * held by entitlement's sweep is told with it, now, the usage event
   * carrying it (`endNotice`, `endPeriod`, `days`). With none, 50 and 80 %
   * are held on the Grant (`usageNoticeLevel`, `usageNoticeSince`) for up to
   * 24 h, and the sweep tells them — with a time level that falls due
   * meanwhile, or alone. 95 % is never held. A time level not yet due is
   * never pulled forward: nothing is told early.
   *
   * notification's ledger still lets a level through once per period
   * (`contract.retention.md`); the period is when it opened.
   */
  private async announceThreshold(
    tx: Prisma.TransactionClient,
    config: Omit<ConfigAttribution, 'remoteId'>,
    grant: UsageThresholdGrant & {
      userId: string;
      usagePeriodStartedAt: Date | null;
      startsAt: Date;
      activatedAt: Date | null;
      endsAt: Date | null;
      endSetAt: Date | null;
      endNoticeFor: Date | null;
      endNoticeAt: Date | null;
      usageNoticeLevel: number | null;
      usageNoticeSince: Date | null;
    },
    charged: bigint,
  ): Promise<void> {
    const crossed = usageThresholdCrossed(grant, charged);
    if (!crossed) return;
    const now = new Date();
    const usagePeriod = grant.usagePeriodStartedAt ?? grant.startsAt;
    // The hold began at the period's first untold crossing; a higher level replaces the lower, never restarts the wait.
    const since = heldUsageNotice({ ...grant, usagePeriod })?.since ?? now;
    const step = grant.endsAt
      ? endNoticeStep({ endsAt: grant.endsAt, endSetAt: grant.endSetAt ?? grant.startsAt, activeSince: grant.activatedAt ?? grant.startsAt, endNoticeFor: grant.endNoticeFor, endNoticeAt: grant.endNoticeAt }, now)
      : null;
    let time = step?.notice ?? null;
    const tell = retentionToTell({ time, usage: { level: crossed.level, since } }, now);

    if (tell.time && step && grant.endsAt) {
      // The time level leaves the sweep's clock as the sweep would move it; a sweep that told it first wins.
      const moved = await tx.grant.updateMany({
        where: { id: config.grantId, endsAt: grant.endsAt, endNoticeFor: grant.endNoticeFor, endNoticeAt: grant.endNoticeAt },
        data: { endNoticeFor: grant.endsAt, endNoticeAt: step.next },
      });
      if (moved.count !== 1) time = null;
    }
    if (!tell.usage || (!time && crossed.level !== 95)) {
      await tx.grant.update({ where: { id: config.grantId }, data: { usageNoticeLevel: crossed.level, usageNoticeSince: since }, select: { id: true } });
      return;
    }
    if (grant.usageNoticeSince) {
      await tx.grant.update({ where: { id: config.grantId }, data: { usageNoticeLevel: null, usageNoticeSince: null }, select: { id: true } });
    }
    const event = retentionEvent(
      { tenantId: config.tenantId, userId: grant.userId, grantId: config.grantId, usagePeriod, endsAt: grant.endsAt },
      { usage: { level: crossed.level, remaining: remainingLabel(crossed.remainingBytes) }, time: tell.time ? time : null },
      now,
    );
    if (!event) return;
    await tx.outboxEvent.create({
      data: { aggregate: 'entitlement.grant', aggregateId: config.grantId, type: event.type, payload: event.payload },
      select: { id: true },
    });
  }

  /**
   * Tell the owner's open My services the total this transaction committed
   * (F-307-t), at most once per {@link USAGE_PUSH_EVERY_MS} per Grant. The
   * slot is claimed on the Grant row the charge already holds locked, so two
   * replicas charging one Grant announce once, and the event commits or rolls
   * back with the bytes it reports (ADR-0021). The figure is the committed
   * total, never a delta: a push lost or skipped costs nothing, the next one
   * carries everything. A window's last bytes wait for the next charge.
   */
  private async announceUsage(tx: Prisma.TransactionClient, config: Omit<ConfigAttribution, 'remoteId'>, userId: string, consumedBytes: bigint): Promise<void> {
    const now = new Date();
    const slot = await tx.grant.updateMany({
      where: { id: config.grantId, OR: [{ usagePushedAt: null }, { usagePushedAt: { lt: new Date(now.getTime() - USAGE_PUSH_EVERY_MS) } }] },
      data: { usagePushedAt: now },
    });
    if (slot.count !== 1) return;
    await tx.outboxEvent.create({
      data: {
        aggregate: 'entitlement.grant',
        aggregateId: config.grantId,
        type: OutboxEventType.GRANT_USAGE,
        payload: { tenantId: config.tenantId, userId, grantId: config.grantId, consumedBytes: consumedBytes.toString() },
      },
      select: { id: true },
    });
  }

  /** Hold one delta, for the same price as billing it: the seen row is written either way. */
  private hold(panelId: string, config: ConfigAttribution, delta: UsageDeltaRow): Promise<boolean> {
    const up = BigInt(delta.upBytes);
    const down = BigInt(delta.downBytes);
    return this.onceUnder(config.tenantId, async (tx) => {
      await tx.usageDeltaSeen.create({
        data: { deltaId: delta.deltaId, configId: config.id, panelId, upBytes: up, downBytes: down, observedAt: new Date(delta.observedAt) },
      });
      await tx.usageHold.create({
        data: {
          configId: config.id,
          panelId,
          upBytes: up,
          downBytes: down,
          reason: HoldReason.attribution_ambiguous,
          heldFrom: new Date(delta.observedAt),
        },
      });
    });
  }

  /**
   * One transaction, under one tenant, whose first statement binds
   * `app.tenant_id` and whose second is the `usage_delta_seen` insert.
   *
   * `false` is the unique violation — the delta was applied by an earlier
   * delivery or by another replica between the read above and here, and
   * everything in this transaction rolls back with it. Any other failure is
   * rethrown, because a message that could not be applied must dead-letter
   * rather than be acked as handled.
   */
  private async onceUnder(tenantId: string, work: (tx: Prisma.TransactionClient) => Promise<void>): Promise<boolean> {
    try {
      await runWithTenant({ id: tenantId }, async () => await tenantTransaction(this.prisma, work));
      return true;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return false;
      throw err;
    }
  }

  /**
   * Store the pass's own quarantines (ADR-0074): figures the collector measured
   * and does not believe. Deduplicated by the same derived `deltaId` the deltas
   * carry — `usage_delta_seen` cannot hold them, because a quarantined row's
   * `configId` is nullable and that column is not.
   */
  private async quarantine(panelId: string, rows: UsageQuarantineRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    const stored = await this.prisma.usageDeltaQuarantine.findMany({
      where: { deltaId: { in: rows.map((r) => r.deltaId) } },
      select: { deltaId: true },
    });
    const seen = new Set(stored.map((row) => row.deltaId));
    const fresh = rows.filter((row) => !seen.has(row.deltaId));
    if (fresh.length === 0) return 0;
    const { count } = await this.prisma.usageDeltaQuarantine.createMany({
      data: fresh.map((row) => ({
        deltaId: row.deltaId,
        configId: row.configId,
        panelId,
        upBytes: BigInt(row.upBytes),
        downBytes: BigInt(row.downBytes),
        observedAt: new Date(row.observedAt),
        reason: row.reason,
      })),
    });
    return count;
  }

  /**
   * Usage against a remote client no config claims (invariant 24: one row per
   * `(panel, remote identifier)`).
   *
   * Deduplicated on `lastSeenAt` rather than on an id, because these rows have
   * none: the update only applies bytes observed *after* what the row already
   * counted, so a redelivered pass — which carries the same `observedAt` —
   * adds nothing. Without that a retried message inflates the one number the
   * unattributed report exists to show.
   */
  private async writeDown(
    panelId: string,
    remoteIdentifier: string,
    row: Pick<UsageUnattributedRow, 'upBytes' | 'downBytes' | 'observedAt'>,
  ): Promise<boolean> {
    const up = BigInt(row.upBytes);
    const down = BigInt(row.downBytes);
    const observedAt = new Date(row.observedAt);
    const { count } = await this.prisma.unattributedUsage.updateMany({
      where: { panelId, remoteIdentifier, lastSeenAt: { lt: observedAt } },
      data: {
        upBytes: { increment: up },
        downBytes: { increment: down },
        observationCount: { increment: 1 },
        lastSeenAt: observedAt,
      },
    });
    if (count > 0) return true;
    try {
      await this.prisma.unattributedUsage.create({
        data: { panelId, remoteIdentifier, upBytes: up, downBytes: down, lastSeenAt: observedAt },
      });
      return true;
    } catch (err) {
      // The row exists and its `lastSeenAt` is at or past this observation:
      // this pass has already been counted into it.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return false;
      throw err;
    }
  }
}

/** The four columns of a `config` this consumer reads, and no usage. */
interface ConfigAttribution {
  id: string;
  tenantId: string;
  grantId: string;
  remoteId: string | null;
}
