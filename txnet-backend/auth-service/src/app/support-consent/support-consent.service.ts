import { Injectable } from '@nestjs/common';
import { AdminAction, Prisma, SupportConsentScope } from '@prisma/client';
import {
  AdmittedReseller,
  EMERGENCY_ENTRY_HOURS,
  mayEnterEmergency,
  OutboxEventType,
  ResellerAccess,
  ResellerAccessRefused,
  ResellerAccessRejection,
  TenantCapabilityName,
  tenantTransaction,
  SUPPORT_CONSENT_DEFAULT_HOURS,
  SUPPORT_CONSENT_MAX_HOURS,
} from '@txnet-backend/shared-core';

import { ImpersonationLeash } from '../impersonation/impersonation-leash';
import { PrismaService } from '../prisma/prisma.service';

/** Who is asking, as `AuthGuard` left them on the request. */
export type SupportConsentActor = { userId: string; tenantId: string; permissions: string[] };

export type SupportConsentRejection =
  | ResellerAccessRejection
  | 'platform_cannot_grant'
  | 'only_platform_requests'
  | 'request_pending'
  | 'hours_out_of_range'
  | 'consent_not_found'
  | 'reseller_only'
  | 'emergency_not_permitted'
  | 'emergency_live';

export class SupportConsentRefused extends Error {
  constructor(readonly reason: SupportConsentRejection) {
    super(`support consent refused: ${reason}`);
    this.name = 'SupportConsentRefused';
  }
}

/** What a row is now — derived on read, never stored, so expiry needs no sweep. */
export type ConsentState = 'requested' | 'live' | 'expired' | 'revoked' | 'declined';

export type ConsentView = {
  id: string;
  scope: SupportConsentScope;
  state: ConsentState;
  reason: string | null;
  requestedByUserId: string | null;
  requestedAt: string | null;
  grantedByUserId: string | null;
  grantedAt: string | null;
  expiresAt: string | null;
  revokedByUserId: string | null;
  revokedAt: string | null;
};

type Row = Prisma.SupportAccessConsentGetPayload<object>;

const HOUR = 3600_000;
const HISTORY = 50;
/** One page of the platform's trail in a reseller (F-117-c). */
export const ACTIVITY_PAGE = 50;
/** What the trail lists: the platform's own requests among the reseller's people (ADR-0104 (6)). */
const TRAIL_ACTIONS: AdminAction[] = ['platform_access'];

/** One request of the platform's staff, as the reseller reads it. The staff member's address is not in it. */
export type PlatformActivityView = {
  id: string;
  at: string;
  actorUserId: string;
  tier: string;
  consentId: string | null;
  entryId: string | null;
  scope: string | null;
  act: string;
  target: Record<string, string>;
};

function activityView(row: { id: string; adminId: string; createdAt: Date; newValue: Prisma.JsonValue }): PlatformActivityView {
  const v = (row.newValue ?? {}) as Record<string, unknown>;
  return {
    id: row.id,
    at: row.createdAt.toISOString(),
    actorUserId: row.adminId,
    tier: String(v.tier ?? ''),
    consentId: (v.consentId as string | undefined) ?? null,
    entryId: (v.entryId as string | undefined) ?? null,
    scope: (v.scope as string | undefined) ?? null,
    act: String(v.act ?? ''),
    target: (v.target as Record<string, string> | undefined) ?? {},
  };
}

/** One emergency entry (F-117-d), as both sides read it: the reseller sees who, why and for how long. */
export type EmergencyEntryView = {
  id: string;
  userId: string;
  reason: string;
  state: 'live' | 'ended' | 'expired';
  startedAt: string;
  expiresAt: string;
  endedAt: string | null;
};

type EntryRow = Prisma.EmergencyAccessEntryGetPayload<object>;

/** The outbox aggregate of a reseller's emergency entries (F-117-d). */
const EMERGENCY_AGGREGATE = 'tenant.support';

function entryView(row: EntryRow, now: Date): EmergencyEntryView {
  return {
    id: row.id,
    userId: row.userId,
    reason: row.reason,
    state: row.endedAt ? 'ended' : row.expiresAt > now ? 'live' : 'expired',
    startedAt: row.startedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
  };
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

function stateOf(row: Row, now: Date): ConsentState {
  if (!row.grantedAt) return row.revokedAt ? 'declined' : 'requested';
  if (row.revokedAt) return 'revoked';
  return row.expiresAt && row.expiresAt > now ? 'live' : 'expired';
}

function view(row: Row, now: Date): ConsentView {
  return {
    id: row.id,
    scope: row.scope,
    state: stateOf(row, now),
    reason: row.reason ?? null,
    requestedByUserId: row.requestedByUserId ?? null,
    requestedAt: iso(row.requestedAt),
    grantedByUserId: row.grantedByUserId ?? null,
    grantedAt: iso(row.grantedAt),
    expiresAt: iso(row.expiresAt),
    revokedByUserId: row.revokedByUserId ?? null,
    revokedAt: iso(row.revokedAt),
  };
}

/**
 * The platform's time-bound access to a reseller's people (F-117-a, ADR-0104
 * (4), catalog §3.7): `/api/auth/tenants/:tenantId/support-consent`.
 *
 * **The platform may ask; only the reseller grants.** `ResellerAccess` admits
 * the reseller's owner and the platform's staff — no member: consent is the
 * owner's (AC-1-e);
 * a grant or a default refuses the last (`platform_cannot_grant`), a request
 * refuses the first (`only_platform_requests`). Revoke is anyone's the door
 * admits: the reseller ends access, the platform withdraws its ask or leaves.
 *
 * Every boundary is one `admin_audit_log` row in the reseller's trail, in the
 * act's transaction and after it (audit invariant 13). A consent's state is
 * derived on read (`liveSupportConsent` is the door's reader), so an expiry
 * needs no job and no write. Every read and write is in a `tenantTransaction`:
 * these tables are under RLS and not in `withTenant`'s registry, so a bare
 * query binds no tenant — it would see nothing and insert nothing.
 *
 * Capability `account` on the writes: a suspended reseller still grants and
 * revokes — support is when suspension most needs it.
 */
@Injectable()
export class SupportConsentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ResellerAccess,
    private readonly leash: ImpersonationLeash,
  ) {}

  list(actor: SupportConsentActor, tenantId: string, now = new Date()) {
    return this.run(actor, tenantId, 'read', async (reseller) => {
      const [policy, rows, entries] = await tenantTransaction(this.prisma, (tx) =>
        Promise.all([
          tx.supportConsentPolicy.findUnique({ where: { tenantId: reseller.id } }),
          tx.supportAccessConsent.findMany({
            where: { tenantId: reseller.id },
            orderBy: { createdAt: 'desc' },
            take: HISTORY,
          }),
          tx.emergencyAccessEntry.findMany({
            where: { tenantId: reseller.id },
            orderBy: { startedAt: 'desc' },
            take: HISTORY,
          }),
        ]),
      );
      return {
        defaultHours: policy?.defaultHours ?? SUPPORT_CONSENT_DEFAULT_HOURS,
        items: rows.map((r) => view(r, now)),
        emergency: entries.map((e) => entryView(e, now)),
      };
    });
  }

  /**
   * What the platform's staff did among the reseller's people, newest first
   * (F-117-c, ADR-0104 (6)): one row per admitted request, reads included. The
   * reseller's to read — its owner — not the
   * platform's (`reseller_only`): the rows name its users.
   */
  activity(actor: SupportConsentActor, tenantId: string, page: number) {
    return this.run(actor, tenantId, 'read', async (reseller) => {
      if (reseller.as === 'staff') throw new SupportConsentRefused('reseller_only');
      const rows = await tenantTransaction(this.prisma, (tx) =>
        tx.adminAuditLog.findMany({
          where: { tenantId: reseller.id, action: { in: TRAIL_ACTIONS } },
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * ACTIVITY_PAGE,
          take: ACTIVITY_PAGE,
          select: { id: true, adminId: true, createdAt: true, newValue: true },
        }),
      );
      return { page, items: rows.map(activityView) };
    });
  }

  request(
    actor: SupportConsentActor,
    tenantId: string,
    input: { scope: SupportConsentScope; reason: string },
    ip: string,
    now = new Date(),
  ): Promise<ConsentView> {
    return this.run(actor, tenantId, 'read', async (reseller) => {
      if (reseller.as !== 'staff') throw new SupportConsentRefused('only_platform_requests');
      return tenantTransaction(this.prisma, async (tx) => {
        const pending = await tx.supportAccessConsent.findFirst({
          where: { tenantId: reseller.id, grantedAt: null, revokedAt: null },
        });
        if (pending) throw new SupportConsentRefused('request_pending');
        const row = await tx.supportAccessConsent.create({
          data: {
            tenantId: reseller.id,
            scope: input.scope,
            reason: input.reason,
            requestedByUserId: actor.userId,
            requestedAt: now,
          },
        });
        await this.audit(tx, reseller, actor, 'support_consent_request', row, null, ip, input.reason);
        return view(row, now);
      });
    });
  }

  grant(
    actor: SupportConsentActor,
    tenantId: string,
    input: { scope: SupportConsentScope; hours?: number; reason?: string; requestId?: string },
    ip: string,
    now = new Date(),
  ): Promise<ConsentView> {
    return this.run(actor, tenantId, 'account', async (reseller) => {
      if (reseller.as === 'staff') throw new SupportConsentRefused('platform_cannot_grant');
      if (input.hours !== undefined && (input.hours < 1 || input.hours > SUPPORT_CONSENT_MAX_HOURS)) {
        throw new SupportConsentRefused('hours_out_of_range');
      }
      let superseded: string[] = [];
      const out = await tenantTransaction(this.prisma, async (tx) => {
        const hours =
          input.hours ??
          (await tx.supportConsentPolicy.findUnique({ where: { tenantId: reseller.id } }))?.defaultHours ??
          SUPPORT_CONSENT_DEFAULT_HOURS;
        const pending = input.requestId
          ? await tx.supportAccessConsent.findFirst({
              where: { id: input.requestId, tenantId: reseller.id, grantedAt: null, revokedAt: null },
            })
          : null;
        if (input.requestId && !pending) throw new SupportConsentRefused('consent_not_found');

        // One live consent at a time: a new grant ends the one before it, and what rode on it (F-117-e).
        superseded = (
          await tx.supportAccessConsent.findMany({
            where: { tenantId: reseller.id, grantedAt: { not: null }, revokedAt: null, expiresAt: { gt: now } },
            select: { id: true },
          })
        ).map((r) => r.id);
        await tx.supportAccessConsent.updateMany({
          where: { tenantId: reseller.id, grantedAt: { not: null }, revokedAt: null, expiresAt: { gt: now } },
          data: { revokedAt: now, revokedByUserId: actor.userId },
        });
        const granted = {
          scope: input.scope,
          grantedByUserId: actor.userId,
          grantedAt: now,
          expiresAt: new Date(now.getTime() + hours * HOUR),
          ...(input.reason ? { reason: input.reason } : {}),
        };
        const row = pending
          ? await tx.supportAccessConsent.update({ where: { id: pending.id }, data: granted })
          : await tx.supportAccessConsent.create({ data: { tenantId: reseller.id, ...granted } });
        await this.audit(tx, reseller, actor, 'support_consent_grant', row, pending, ip, input.reason ?? null);
        return view(row, now);
      });
      await this.leash.endUnder({ consentIds: superseded }, now);
      return out;
    });
  }

  revoke(actor: SupportConsentActor, tenantId: string, consentId: string, ip: string, now = new Date()): Promise<ConsentView> {
    return this.run(actor, tenantId, 'account', async (reseller) => {
      const out = await tenantTransaction(this.prisma, async (tx) => {
        // A request still open, or a grant still running: nothing else ends.
        const open = await tx.supportAccessConsent.findFirst({
          where: { id: consentId, tenantId: reseller.id, revokedAt: null },
        });
        if (!open || stateOf(open, now) === 'expired') throw new SupportConsentRefused('consent_not_found');
        const before = { ...open };
        const row = await tx.supportAccessConsent.update({
          where: { id: open.id },
          data: { revokedAt: now, revokedByUserId: actor.userId },
        });
        await this.audit(tx, reseller, actor, 'support_consent_revoke', row, before, ip, null);
        return view(row, now);
      });
      // Committed: an impersonation riding on it ends now, not at its 30 minutes (F-117-e).
      await this.leash.endUnder({ consentIds: [consentId] }, now);
      return out;
    });
  }

  setPolicy(actor: SupportConsentActor, tenantId: string, defaultHours: number, ip: string) {
    return this.run(actor, tenantId, 'account', async (reseller) => {
      if (reseller.as === 'staff') throw new SupportConsentRefused('platform_cannot_grant');
      return tenantTransaction(this.prisma, async (tx) => {
        const before = await tx.supportConsentPolicy.findUnique({ where: { tenantId: reseller.id } });
        await tx.supportConsentPolicy.upsert({
          where: { tenantId: reseller.id },
          create: { tenantId: reseller.id, defaultHours },
          update: { defaultHours },
        });
        await tx.adminAuditLog.create({
          data: {
            tenantId: reseller.id,
            adminId: actor.userId,
            action: 'support_consent_policy_set',
            targetEntityType: 'tenant',
            targetEntityId: reseller.id,
            oldValue: { defaultHours: before?.defaultHours ?? SUPPORT_CONSENT_DEFAULT_HOURS },
            newValue: { defaultHours },
            adminIpAddress: ip,
          },
        });
        return { defaultHours };
      });
    });
  }

  /**
   * Tier C (F-117-d, ADR-0104 (5)): a platform staff member holding
   * `tenant.emergency_access` (`mayEnterEmergency`) enters the reseller without its consent,
   * for exactly {@link EMERGENCY_ENTRY_HOURS} hour from now, with a reason. Never
   * extended: while their entry runs a second is `emergency_live`. The entry,
   * its audit row and the owner's notice (an outbox event) commit together, so
   * the entry stands whatever becomes of delivering the notice. The reason is
   * recorded and shown in the reseller's history, never put in the notice.
   */
  enterEmergency(
    actor: SupportConsentActor,
    tenantId: string,
    input: { reason: string },
    ip: string,
    now = new Date(),
  ): Promise<EmergencyEntryView> {
    return this.run(actor, tenantId, 'read', async (reseller) => {
      if (reseller.as !== 'staff') throw new SupportConsentRefused('only_platform_requests');
      if (!mayEnterEmergency(actor.permissions)) throw new SupportConsentRefused('emergency_not_permitted');
      return tenantTransaction(this.prisma, async (tx) => {
        const running = await tx.emergencyAccessEntry.findFirst({
          where: { tenantId: reseller.id, userId: actor.userId, endedAt: null, expiresAt: { gt: now } },
        });
        if (running) throw new SupportConsentRefused('emergency_live');
        const row = await tx.emergencyAccessEntry.create({
          data: {
            tenantId: reseller.id,
            userId: actor.userId,
            reason: input.reason,
            startedAt: now,
            expiresAt: new Date(now.getTime() + EMERGENCY_ENTRY_HOURS * HOUR),
          },
        });
        await tx.adminAuditLog.create({
          data: {
            tenantId: reseller.id,
            adminId: actor.userId,
            action: 'emergency_entry_open',
            targetEntityType: 'emergency_entry',
            targetEntityId: row.id,
            newValue: { startedAt: iso(row.startedAt), expiresAt: iso(row.expiresAt) },
            adminIpAddress: ip,
            reason: input.reason,
          },
        });
        const tenant = await tx.tenant.findUnique({ where: { id: reseller.id }, select: { ownerUserId: true } });
        if (tenant) {
          await tx.outboxEvent.create({
            data: {
              aggregate: EMERGENCY_AGGREGATE,
              aggregateId: reseller.id,
              type: OutboxEventType.TENANT_EMERGENCY_ENTRY,
              payload: { tenantId: reseller.id, ownerUserId: tenant.ownerUserId, entryId: row.id, expiresAt: row.expiresAt.toISOString() },
            },
            select: { id: true },
          });
        }
        return entryView(row, now);
      });
    });
  }

  /** Its entrant leaves early (F-117-d). Anyone else, or an entry already over, is `consent_not_found`. */
  endEmergency(actor: SupportConsentActor, tenantId: string, entryId: string, ip: string, now = new Date()): Promise<EmergencyEntryView> {
    return this.run(actor, tenantId, 'read', async (reseller) => {
      const out = await tenantTransaction(this.prisma, async (tx) => {
        const running = await tx.emergencyAccessEntry.findFirst({
          where: { id: entryId, tenantId: reseller.id, userId: actor.userId, endedAt: null, expiresAt: { gt: now } },
        });
        if (!running) throw new SupportConsentRefused('consent_not_found');
        const row = await tx.emergencyAccessEntry.update({ where: { id: running.id }, data: { endedAt: now, endedByUserId: actor.userId } });
        await tx.adminAuditLog.create({
          data: {
            tenantId: reseller.id,
            adminId: actor.userId,
            action: 'emergency_entry_end',
            targetEntityType: 'emergency_entry',
            targetEntityId: row.id,
            oldValue: { endedAt: null },
            newValue: { endedAt: iso(now) },
            adminIpAddress: ip,
          },
        });
        return entryView(row, now);
      });
      await this.leash.endUnder({ entryId }, now);
      return out;
    });
  }

  /** Admit, run in the reseller's scope, and translate the door's refusal so the controller maps one type. */
  private async run<T>(
    actor: SupportConsentActor,
    tenantId: string,
    capability: TenantCapabilityName,
    work: (reseller: AdmittedReseller) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.access.run(actor, tenantId, capability, work);
    } catch (err) {
      if (err instanceof ResellerAccessRefused) throw new SupportConsentRefused(err.reason);
      throw err;
    }
  }

  private async audit(
    tx: Prisma.TransactionClient,
    reseller: AdmittedReseller,
    actor: SupportConsentActor,
    action: AdminAction,
    row: Row,
    before: Row | null,
    ip: string,
    reason: string | null,
  ) {
    const snapshot = (r: Row) => ({
      scope: r.scope,
      grantedAt: iso(r.grantedAt),
      expiresAt: iso(r.expiresAt),
      revokedAt: iso(r.revokedAt),
    });
    await tx.adminAuditLog.create({
      data: {
        // The reseller's own trail (ADR-0104 (6)): it reads who entered and when.
        tenantId: reseller.id,
        adminId: actor.userId,
        action,
        targetEntityType: 'support_consent',
        targetEntityId: row.id,
        oldValue: before ? snapshot(before) : Prisma.JsonNull,
        newValue: snapshot(row),
        adminIpAddress: ip,
        reason,
      },
    });
  }
}
