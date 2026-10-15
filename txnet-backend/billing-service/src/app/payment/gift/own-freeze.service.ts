import { ForbiddenException, ConflictException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { AdminAction, FreezeMode, Prisma } from '@prisma/client';
import { BackendI18nKeys, TenantContext, tenantTransaction } from '@txnet-backend/shared-core';

import { emitFreezeChanged } from '../../entitlement/freeze';
import { EntitlementRefused, EntitlementRejection } from '../../entitlement/grant';
import { freezeOwnGrant, SelfFreezeLimited, unfreezeOwn } from '../../entitlement/self-freeze';
import { AuditActor, auditedOwnGrantAct, OwnGrantAuditAction } from '../../grant-audit/grant-audit';
import { PrismaService } from '../../prisma/prisma.service';

const E = BackendI18nKeys.errors.billing.grant;

/** Each refusal of the user's freeze and unfreeze, as its status and message; any other passes through. */
const OWN_FREEZE_REFUSAL: Partial<Record<EntitlementRejection, { status: 403 | 404 | 409; i18nKey: string }>> = {
  grant_not_found: { status: 404, i18nKey: E.notFound },
  grant_not_metered: { status: 409, i18nKey: E.selfFreezeNotMetered },
  self_freeze_off: { status: 403, i18nKey: E.selfFreezeOff },
  grant_not_active: { status: 409, i18nKey: E.notFreezable },
  grant_not_frozen: { status: 409, i18nKey: E.notFrozen },
  freeze_not_users: { status: 403, i18nKey: E.freezeNotUsers },
  grant_moved: { status: 409, i18nKey: E.freezeMoved },
};

const EXCEPTION_OF = { 403: ForbiddenException, 404: NotFoundException, 409: ConflictException } as const;

/**
 * The user freezes and unfreezes their own Grant (F-0401-c, billing
 * `contract.gift.md` "Self-freeze"): the rules are `entitlement/self-freeze.ts`'s;
 * this writes each act down as the user, in its transaction, and the live
 * event their pages re-read on. The tenant is the request's, the user the gate's.
 */
@Injectable()
export class OwnFreezeService {
  constructor(private readonly prisma: PrismaService) {}

  async freeze(actor: AuditActor, grantId: string) {
    const done = await this.act(actor, grantId, AdminAction.grant_self_freeze, (tx, at) => freezeOwnGrant(tx, grantId, actor.userId, at));
    return { grantId, freezeMode: FreezeMode.self, configsDisabled: done.configsDisabled };
  }

  async unfreeze(actor: AuditActor, grantId: string) {
    const done = await this.act(actor, grantId, AdminAction.grant_self_unfreeze, (tx, at) => unfreezeOwn(tx, grantId, actor.userId, at));
    return { grantId, endsAt: done.endsAt?.toISOString() ?? null, configsRestored: done.configsRestored };
  }

  private async act<T>(actor: AuditActor, grantId: string, action: OwnGrantAuditAction, work: (tx: Prisma.TransactionClient, at: Date) => Promise<T>): Promise<T> {
    const tenantId = TenantContext.current('a self-freeze').id;
    try {
      return await tenantTransaction(this.prisma, async (tx) => {
        const done = await auditedOwnGrantAct(tx, actor, tenantId, grantId, action, () => work(tx, new Date()));
        await emitFreezeChanged(tx, { tenantId, userId: actor.userId, grantId });
        return done;
      });
    } catch (e) {
      throw refusalOf(e);
    }
  }
}

/** A refusal as its HTTP answer; anything else unchanged. */
function refusalOf(e: unknown): unknown {
  // The fourth freeze in a day: when the next is allowed, as epoch ms (`facts` carries no text).
  if (e instanceof SelfFreezeLimited) {
    return new HttpException(
      { i18nKey: E.selfFreezeLimited, reason: e.reason, message: `${e.name}: ${e.message}`, facts: { limit: e.limit, nextAtMs: e.nextAt.getTime() } },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
  if (!(e instanceof EntitlementRefused)) return e;
  const refusal = OWN_FREEZE_REFUSAL[e.reason];
  if (!refusal) return e;
  return new EXCEPTION_OF[refusal.status]({ i18nKey: refusal.i18nKey, reason: e.reason, message: `${e.name}: ${e.message}` });
}
