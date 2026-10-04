import { Injectable } from '@nestjs/common';
import { AdminAction, Prisma, SupportConsentScope } from '@prisma/client';
import {
  AdmittedReseller,
  ResellerAccess,
  ResellerAccessRefused,
  ResellerAccessRejection,
  TenantCapabilityName,
  SUPPORT_CONSENT_DEFAULT_HOURS,
  SUPPORT_CONSENT_MAX_HOURS,
} from '@txnet-backend/shared-core';

import { PrismaService } from '../prisma/prisma.service';

/** Who is asking, as `AuthGuard` left them on the request. */
export type SupportConsentActor = { userId: string; tenantId: string; permissions: string[] };

export type SupportConsentRejection =
  | ResellerAccessRejection
  | 'platform_cannot_grant'
  | 'only_platform_requests'
  | 'request_pending'
  | 'hours_out_of_range'
  | 'consent_not_found';

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
 * the reseller's owner, a `tenant.manage` seat of it, and the platform's staff;
 * a grant or a default refuses the last (`platform_cannot_grant`), a request
 * refuses the first two (`only_platform_requests`). Revoke is anyone's the door
 * admits: the reseller ends access, the platform withdraws its ask or leaves.
 *
 * Every boundary is one `admin_audit_log` row in the reseller's trail, in the
 * act's transaction and after it (audit invariant 13). A consent's state is
 * derived on read (`liveSupportConsent` is the door's reader), so an expiry
 * needs no job and no write.
 *
 * Capability `account` on the writes: a suspended reseller still grants and
 * revokes — support is when suspension most needs it.
 */
@Injectable()
export class SupportConsentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ResellerAccess,
  ) {}

  list(actor: SupportConsentActor, tenantId: string, now = new Date()) {
    return this.run(actor, tenantId, 'read', async (reseller) => {
      const [policy, rows] = await Promise.all([
        this.prisma.supportConsentPolicy.findUnique({ where: { tenantId: reseller.id } }),
        this.prisma.supportAccessConsent.findMany({
          where: { tenantId: reseller.id },
          orderBy: { createdAt: 'desc' },
          take: HISTORY,
        }),
      ]);
      return {
        defaultHours: policy?.defaultHours ?? SUPPORT_CONSENT_DEFAULT_HOURS,
        items: rows.map((r) => view(r, now)),
      };
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
      return this.prisma.$transaction(async (tx) => {
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
      return this.prisma.$transaction(async (tx) => {
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

        // One live consent at a time: a new grant ends the one before it.
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
    });
  }

  revoke(actor: SupportConsentActor, tenantId: string, consentId: string, ip: string, now = new Date()): Promise<ConsentView> {
    return this.run(actor, tenantId, 'account', async (reseller) => {
      return this.prisma.$transaction(async (tx) => {
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
    });
  }

  setPolicy(actor: SupportConsentActor, tenantId: string, defaultHours: number, ip: string) {
    return this.run(actor, tenantId, 'account', async (reseller) => {
      if (reseller.as === 'staff') throw new SupportConsentRefused('platform_cannot_grant');
      return this.prisma.$transaction(async (tx) => {
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
