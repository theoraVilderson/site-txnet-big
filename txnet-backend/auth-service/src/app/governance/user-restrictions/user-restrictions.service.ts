import { Injectable } from '@nestjs/common';
import { AdminAction, type Prisma } from '@prisma/client';
import {
  AdmittedReseller,
  ResellerAccess,
  ResellerAccessRefused,
  ResellerAccessRejection,
  ResellerActor,
  SupportConsentRefused,
  SupportConsentRejection,
  TenantCapabilityName,
  USER_RESTRICTIONS,
  USER_RESTRICTION_KEYS,
  isPlatformTenant,
  isUserRestrictionKey,
  liveRestriction,
  restrictionValueOf,
  tenantTransaction,
  type UserRestrictionKey,
  type UserRestrictionValue,
} from '@txnet-backend/shared-core';

import { AccessReader } from '../../auth/permissions/access.reader';
import { TARGET_PERMISSIONS_SELECT, authorityOver } from '../../auth/users/authority';
import { auditPersonAct, type PersonAct } from '../../auth/users/person-act-audit';
import { PrismaService } from '../../prisma/prisma.service';

export type UserRestrictionsRejection =
  | ResellerAccessRejection
  | SupportConsentRejection
  | 'user_not_found'
  | 'no_authority'
  | 'restriction_unknown'
  | 'restriction_value_invalid'
  | 'restriction_not_found'
  | 'expiry_past';

export class UserRestrictionsRefused extends Error {
  constructor(
    readonly reason: UserRestrictionsRejection,
    detail = '',
  ) {
    super(`user restrictions refused: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'UserRestrictionsRefused';
  }
}

/** One restriction as staff read it: what, how much, why, by whom, since when, until when. */
export type UserRestrictionEntry = { key: string; value: unknown; reason: string; by: string; at: string; expiresAt: string | null };

/** A registry key as a form offers it: a count up to `max`, or a set from `options`. */
export type UserRestrictionKeyView = { key: UserRestrictionKey; kind: 'count' | 'set'; max?: number; options?: string[] };

/** A person's restrictions that hold now, and every key that may be set (F-030-d). */
export type UserRestrictionsView = { userId: string; restrictions: UserRestrictionEntry[]; keys: UserRestrictionKeyView[] };

export type UserRestrictionInput = { value: unknown; reason: string; expiresAt?: Date | null };

type Tx = Prisma.TransactionClient;

/** The door's key (ADR-0133 decision 6's): who may restrict a person may cap them. */
const RESTRICTION_ASSIGN = 'restriction.assign';

/** The registry as a form reads it, in the registry's order. */
const KEY_VIEWS: UserRestrictionKeyView[] = USER_RESTRICTION_KEYS.map((key) => {
  const rule: { kind: 'count'; max: number } | { kind: 'set'; options: readonly string[] } = USER_RESTRICTIONS[key];
  return rule.kind === 'count' ? { key, kind: rule.kind, max: rule.max } : { key, kind: rule.kind, options: [...rule.options] };
});

/**
 * A cap or a bar on one person (F-030-d, §3.9), on the tenant's own path —
 * `/auth/tenants/:tenantId/users/:userId/restrictions` — through the reseller
 * door with `restriction.assign`, as a person's keys go through it with
 * `role.manage` (`TenantRolesService`). Which keys exist and what each value
 * may be is the registry's (`USER_RESTRICTIONS`, shared-core); where a
 * restriction bites is F-030-e's.
 *
 * Every write asks ADR-0103's authority rule over the person's whole answer
 * less their `self.` keys (as `UserStatusService` does) and leaves one audit
 * row with its reason. The same value, reason and expiry again writes nothing.
 */
@Injectable()
export class UserRestrictionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ResellerAccess,
    private readonly answers: AccessReader,
  ) {}

  list(actor: ResellerActor, tenantId: string, userId: string): Promise<UserRestrictionsView> {
    return this.run(actor, tenantId, 'read', () =>
      tenantTransaction(this.prisma, async (tx) => {
        await this.person(tx, userId);
        return this.view(tx, userId);
      }),
    );
  }

  set(actor: ResellerActor, tenantId: string, userId: string, key: string, input: UserRestrictionInput, ip: string): Promise<UserRestrictionsView> {
    if (!isUserRestrictionKey(key)) return Promise.reject(new UserRestrictionsRefused('restriction_unknown', key));
    const value = restrictionValueOf(key, input.value);
    if (value === null) return Promise.reject(new UserRestrictionsRefused('restriction_value_invalid', key));
    const expiresAt = input.expiresAt ?? null;
    if (expiresAt && expiresAt <= new Date()) return Promise.reject(new UserRestrictionsRefused('expiry_past', key));
    const reason = input.reason.trim();

    return this.writing(actor, tenantId, userId, ip, async (tx, person) => {
      const where = { userId_key: { userId, key } };
      const current = await tx.userRestriction.findUnique({ where });
      if (current && sameValue(current.value, value) && current.reason === reason && current.expiresAt?.getTime() === expiresAt?.getTime()) return null;
      const data = { value, reason, setByUserId: actor.userId, expiresAt };
      await tx.userRestriction.upsert({ where, create: { userId, key, tenantId: person.tenantId, ...data }, update: data });
      return { action: AdminAction.user_restriction_set, before: current ? auditOf(current) : null, after: auditOf({ key, ...data }), reason };
    });
  }

  /** Lift a restriction by hand, whether or not it has expired. */
  lift(actor: ResellerActor, tenantId: string, userId: string, key: string, ip: string): Promise<UserRestrictionsView> {
    return this.writing(actor, tenantId, userId, ip, async (tx) => {
      const where = { userId_key: { userId, key } };
      const current = await tx.userRestriction.findUnique({ where });
      if (!current) throw new UserRestrictionsRefused('restriction_not_found', key);
      await tx.userRestriction.delete({ where });
      return { action: AdminAction.user_restriction_lift, before: auditOf(current), after: null, reason: null };
    });
  }

  /** Admit, find the person, ask the authority rule, write, audit — then the view after. */
  private writing(
    actor: ResellerActor,
    tenantId: string,
    userId: string,
    ip: string,
    write: (tx: Tx, person: { id: string; tenantId: string }) => Promise<PersonAct | null>,
  ): Promise<UserRestrictionsView> {
    return this.run(actor, tenantId, 'staffWrite', async (admitted) => {
      const tenant = await this.prisma.tenant.findUnique({ where: { id: admitted.id }, select: { ownerUserId: true, tenantType: true } });
      return tenantTransaction(this.prisma, async (tx) => {
        const person = await this.person(tx, userId);
        const answer = await this.answers.ofLoaded(person, tx);
        const refused = authorityOver(
          { userId: actor.userId, permissions: actor.permissions, as: admitted.as },
          // A customer's `self.` keys say what they may do to their own account, not over anyone (`UserStatusService`).
          { userId, permissions: answer.keys.filter((k) => !k.startsWith('self.')) },
          { ownerUserId: tenant?.ownerUserId ?? null, platform: isPlatformTenant(tenant?.tenantType) },
        );
        if (refused) throw new UserRestrictionsRefused('no_authority', `${userId}: ${refused}`);

        const change = await write(tx, person);
        if (change) await auditPersonAct(tx, { tenantId: admitted.id, adminId: actor.userId, userId, ip }, change);
        return this.view(tx, userId);
      });
    });
  }

  /** In the tenant's scope: someone of another tenant is simply not found. */
  private async person(tx: Tx, userId: string) {
    const person = await tx.user.findFirst({ where: { id: userId, deletedAt: null }, select: { id: true, tenantId: true, ...TARGET_PERMISSIONS_SELECT } });
    if (!person) throw new UserRestrictionsRefused('user_not_found', userId);
    return person;
  }

  private async view(tx: Tx, userId: string): Promise<UserRestrictionsView> {
    const rows = await tx.userRestriction.findMany({ where: { userId, ...liveRestriction() }, orderBy: { key: 'asc' } });
    return {
      userId,
      restrictions: rows.map((r) => ({ key: r.key, value: r.value, reason: r.reason, by: r.setByUserId, at: r.updatedAt.toISOString(), expiresAt: r.expiresAt?.toISOString() ?? null })),
      keys: KEY_VIEWS,
    };
  }

  /** Admit through the door on `restriction.assign`, and translate its refusal into this surface's one type. */
  private async run<T>(actor: ResellerActor, tenantId: string, capability: TenantCapabilityName, work: (admitted: AdmittedReseller) => Promise<T>): Promise<T> {
    try {
      return await this.access.for(RESTRICTION_ASSIGN).runIncludingPlatform(actor, tenantId, capability, work);
    } catch (err) {
      if (err instanceof ResellerAccessRefused || err instanceof SupportConsentRefused) throw new UserRestrictionsRefused(err.reason, tenantId);
      throw err;
    }
  }
}

/** A stored value against a parsed one: the set is stored sorted, so its order is the same. */
function sameValue(stored: Prisma.JsonValue, value: UserRestrictionValue): boolean {
  return JSON.stringify(stored) === JSON.stringify(value);
}

/** A restriction as its audit row keeps it; the expiry only when it has one. */
function auditOf(r: { key: string; value: Prisma.JsonValue; reason: string; expiresAt: Date | null }): Prisma.InputJsonObject {
  return { key: r.key, value: r.value as Prisma.InputJsonValue, reason: r.reason, ...(r.expiresAt ? { expiresAt: r.expiresAt.toISOString() } : {}) };
}
