import { Injectable } from '@nestjs/common';
import { TenantStatus, TenantType } from '@prisma/client';
import { holdsPermission, liveSupportConsent, runWithTenant } from '@txnet-backend/shared-core';

import { ConversationRefused, SupportCaller } from '../conversations/refusal';
import { PrismaService } from '../prisma/prisma.service';

/** The permission an agent's role holds — `SupportAgentGuard`'s, spelled here so `tools/contracts.py` sees it. */
const SUPPORT_AGENT_PERMISSION = 'support.agent';

/** What the route needs of the consent: `read` sees, `act` also replies, assigns and changes status. */
export type ConsentNeed = 'read' | 'act';

/** Who the gate proved is calling. */
export type PlatformCaller = { userId: string; tenantId: string; permissions: string[] };

/**
 * Platform staff in a reseller's support (F-033-l, catalog §11.6, ADR-0104
 * (4)): `/api/support/tenants/:tenantId/agent/*`.
 *
 * In order: the caller is the platform owner's staff holding `support.agent`
 * (`not_platform_staff`); the path names a reseller that is not terminated
 * (`reseller_not_found`); that reseller has a live consent (`consent_required`)
 * whose scope covers the route (`consent_read_only`). The consent is read on
 * **every request** through `liveSupportConsent`, so a revoke ends access on
 * the next one; nothing caches it.
 *
 * The work then runs **as the reseller's tenant** (RLS and every
 * `caller.tenantId` filter see its rows, not the platform's) with the staff
 * member as the agent — the same `SupportAgentService` a reseller's own agent
 * calls, so nothing about a conversation is decided twice.
 *
 * `tenant.tenant` has no RLS; it is read on the app pool before any scope opens.
 */
@Injectable()
export class PlatformSupportDoor {
  constructor(private readonly prisma: PrismaService) {}

  async run<T>(
    caller: PlatformCaller,
    tenantId: string,
    need: ConsentNeed,
    work: (agent: SupportCaller) => Promise<T>,
    now = new Date(),
  ): Promise<T> {
    const [home, reseller] = await Promise.all([
      this.prisma.tenant.findUnique({ where: { id: caller.tenantId }, select: { tenantType: true } }),
      this.prisma.tenant.findFirst({
        where: { id: tenantId, tenantType: TenantType.reseller, deletedAt: null },
        select: { id: true, status: true },
      }),
    ]);
    if (home?.tenantType !== TenantType.platform_owner || !holdsPermission(caller.permissions, SUPPORT_AGENT_PERMISSION)) {
      throw new ConversationRefused('not_platform_staff');
    }
    if (!reseller || reseller.status === TenantStatus.terminated) throw new ConversationRefused('reseller_not_found');

    return runWithTenant({ id: reseller.id }, async () => {
      const consent = await liveSupportConsent(this.prisma, reseller.id, now);
      if (!consent) throw new ConversationRefused('consent_required');
      if (need === 'act' && consent.scope !== 'act') throw new ConversationRefused('consent_read_only');
      return await work({ tenantId: reseller.id, userId: caller.userId });
    });
  }
}
