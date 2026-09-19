import { Injectable } from '@nestjs/common';
import {
  BotIntegrationStatus,
  DomainVerificationStatus,
  TenantDomainPurpose,
  TenantDomainType,
  TenantGatewayVerificationStatus,
} from '@prisma/client';
import { TenantOnboardingPolicy, TENANT_CAPABILITIES, TenantCapabilityName, offeredToTenant, ResellerAccess, ResellerAccessRejection, ResellerActor } from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';

/**
 * What a reseller still has to do before it can open (F-018-l, catalog F-213).
 *
 * **Every step is computed from live state, never stored.** There is no
 * `onboardingCompleted` column and no wizard cursor: the answer is a count of
 * the rows that would make the step true, so a reseller that deletes its last
 * gateway is back on that step, and nothing can say "done" about a thing that
 * is no longer there.
 *
 * **Only the domain step is the gate.** A reseller with no `verified` custom
 * `panel` domain has nowhere to serve its users, so
 * {@link TenantOnboardingPolicy} closes registration, sales, end-user deposits
 * and `/sub` for it — the column `TenantStatusListener` writes into
 * `tenant:status:<id>` and `TenantStatusGuard` reads. The other three steps are
 * what the console asks for next; they refuse nothing on their own, because a
 * reseller may sell through a bot it has not connected yet, or price its
 * products the day after it opens. `pricing` means "the catalog offers this
 * reseller something", its own or the platform's — asked through shared-core's
 * `offeredToTenant`, the predicate `listOffers` answers with, never a copy.
 *
 * Read on the cross-tenant pool, after {@link ResellerAccess} — a reseller's
 * domains, gateways, bots and prices are not the caller's tenant's rows, and
 * the platform owner's staff read them from the platform's own tenant.
 */

export type OnboardingStepKey = 'domain' | 'gateway' | 'bot' | 'pricing';

export type OnboardingStep = {
  key: OnboardingStepKey;
  done: boolean;
  /** Only `domain` is: the step whose absence closes capabilities. */
  gate: boolean;
};

export type OnboardingView = {
  tenantId: string;
  /** True while the gate is closed — the same answer the guard enforces. */
  onboarding: boolean;
  /** What the gate closes while `onboarding`, in the order of the matrix. */
  closed: TenantCapabilityName[];
  steps: OnboardingStep[];
  /** Every step done. A reseller can be open (`onboarding: false`) before this. */
  complete: boolean;
};

export type OnboardingRejection = ResellerAccessRejection;

export type OnboardingActor = ResellerActor;

/** The capabilities the column closes, fixed by the policy rather than repeated here. */
const CLOSED = TENANT_CAPABILITIES.filter((c) => TenantOnboardingPolicy[c] === false);

@Injectable()
export class TenantOnboardingService {
  constructor(
    private readonly access: ResellerAccess,
    private readonly all: CrossTenantPrismaService,
  ) {}

  async checklist(actor: OnboardingActor, tenantId: string): Promise<OnboardingView> {
    const reseller = await this.access.admit(actor, tenantId, 'read');
    const [domain, gateway, bot, pricing] = await Promise.all([
      this.hasDoor(reseller.id),
      this.all.tenantGatewayConfig.findFirst({
        where: {
          tenantId: reseller.id,
          isActive: true,
          verificationStatus: TenantGatewayVerificationStatus.verified,
        },
        select: { id: true },
      }),
      this.all.botIntegration.findFirst({
        where: { tenantId: reseller.id, status: BotIntegrationStatus.active },
        select: { id: true },
      }),
      // Something to sell, by the catalog's own rule (F-018-ah): the platform's
      // offers the reseller inherits count as well as its own prices.
      this.all.productVariant.findFirst({ where: offeredToTenant(reseller.id, new Date()), select: { id: true } }),
    ]);
    const steps: OnboardingStep[] = [
      { key: 'domain', done: domain, gate: true },
      { key: 'gateway', done: !!gateway, gate: false },
      { key: 'bot', done: !!bot, gate: false },
      { key: 'pricing', done: !!pricing, gate: false },
    ];
    return {
      tenantId: reseller.id,
      onboarding: !domain,
      closed: [...CLOSED],
      steps,
      complete: steps.every((s) => s.done),
    };
  }

  /**
   * The gate itself, in the same shape `TenantStatusListener` computes it: one
   * `verified` `panel` `custom_domain`. The two read the same rows on purpose —
   * a console that disagrees with the guard is worse than no console.
   */
  private async hasDoor(tenantId: string): Promise<boolean> {
    const door = await this.all.tenantDomain.findFirst({
      where: {
        tenantId,
        domainType: TenantDomainType.custom_domain,
        purpose: TenantDomainPurpose.panel,
        verificationStatus: DomainVerificationStatus.verified,
      },
      select: { id: true },
    });
    return !!door;
  }
}
