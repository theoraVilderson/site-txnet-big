import { Injectable } from '@nestjs/common';
import {
  BotIntegrationStatus,
  DomainVerificationStatus,
  MigrationRunKind,
  MigrationRunStatus,
  TenantDomainPurpose,
  TenantDomainType,
  TenantOnboardingOptionalStep,
} from '@prisma/client';
import { TenantOnboardingPolicy, TENANT_CAPABILITIES, TenantCapabilityName, offeredToTenant, operatingCurrencyOf, platformProductsSoldBy, platformTenantIdOf, ResellerAccess, ResellerAccessRejection, ResellerActor, tenantTransaction } from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';

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
 * **An optional step counts toward nothing** (F-213; user, 2026-10-22):
 * `import`, "bring my users", comes first in the route's order and is done by
 * a committed panel or link import — a balances file brings no users — or by
 * the reseller's skip, the one fact here a person decides and so the one that
 * is stored (`tenant_onboarding_skip`). `complete` is the required steps
 * alone, so a reseller already set up is not pulled back by a new step.
 *
 * Read on the cross-tenant pool, after {@link ResellerAccess} — a reseller's
 * domains, gateways, bots and prices are not the caller's tenant's rows, and
 * the platform owner's staff read them from the platform's own tenant.
 */

/** Spelled out, not the enum's type: the panel's spec reads this union from source. `import` is `TenantOnboardingOptionalStep`'s. */
export type OnboardingStepKey = 'import' | 'domain' | 'gateway' | 'bot' | 'pricing';

export type OnboardingStep = {
  key: OnboardingStepKey;
  done: boolean;
  /** Only `domain` is: the step whose absence closes capabilities. */
  gate: boolean;
  /** Counts toward neither `complete` nor progress; may be skipped. */
  optional: boolean;
  /** Done because the reseller said it does not apply, not by a row. */
  skipped: boolean;
};

export type OnboardingView = {
  tenantId: string;
  /** True while the gate is closed — the same answer the guard enforces. */
  onboarding: boolean;
  /** What the gate closes while `onboarding`, in the order of the matrix. */
  closed: TenantCapabilityName[];
  steps: OnboardingStep[];
  /** Every required step done. A reseller can be open (`onboarding: false`) before this. */
  complete: boolean;
};

export type OnboardingRejection = ResellerAccessRejection;

export type OnboardingActor = ResellerActor;

/** The imports that bring users over: a balances file (`csv`) brings none. */
const USER_IMPORTS = [MigrationRunKind.panel, MigrationRunKind.link];

/** The capabilities the column closes, fixed by the policy rather than repeated here. */
const CLOSED = TENANT_CAPABILITIES.filter((c) => TenantOnboardingPolicy[c] === false);

@Injectable()
export class TenantOnboardingService {
  constructor(
    private readonly access: ResellerAccess,
    private readonly all: CrossTenantPrismaService,
    private readonly prisma: PrismaService,
  ) {}

  async checklist(actor: OnboardingActor, tenantId: string): Promise<OnboardingView> {
    const reseller = await this.access.for('settings.manage').admit(actor, tenantId, 'read');
    const [domain, gateway, bot, pricing, imported, skips] = await Promise.all([
      this.hasDoor(reseller.id),
      this.all.tenantGatewayConfig.findFirst({
        where: {
          tenantId: reseller.id,
          isActive: true,
          // F-104-ak: switched on and not blocked by the platform — no approval step.
          blockedAt: null,
        },
        select: { id: true },
      }),
      this.all.botIntegration.findFirst({
        where: { tenantId: reseller.id, status: BotIntegrationStatus.active },
        select: { id: true },
      }),
      this.somethingToSell(reseller.id),
      this.all.migrationRun.findFirst({
        where: { tenantId: reseller.id, status: MigrationRunStatus.committed, kind: { in: USER_IMPORTS } },
        select: { id: true },
      }),
      this.all.tenantOnboardingSkip.findMany({ where: { tenantId: reseller.id }, select: { step: true } }),
    ]);
    const skipped = skips.some((s) => s.step === TenantOnboardingOptionalStep.import);
    const required = (key: OnboardingStepKey, done: boolean, gate = false): OnboardingStep => ({ key, done, gate, optional: false, skipped: false });
    const steps: OnboardingStep[] = [
      { key: TenantOnboardingOptionalStep.import, done: !!imported || skipped, gate: false, optional: true, skipped },
      required('domain', domain, true),
      required('gateway', !!gateway),
      required('bot', !!bot),
      required('pricing', !!pricing),
    ];
    return {
      tenantId: reseller.id,
      onboarding: !domain,
      closed: [...CLOSED],
      steps,
      complete: steps.every((s) => s.optional || s.done),
    };
  }

  /**
   * "This step does not apply to me" (F-213) — the migration page's own key,
   * since skipping the import is that page's decision. Stored once however
   * often it is sent (the row's key is the tenant and the step, C-29).
   */
  async skip(actor: OnboardingActor, tenantId: string, step: TenantOnboardingOptionalStep): Promise<void> {
    await this.access.for('migration.manage').run(actor, tenantId, 'staffWrite', (reseller) =>
      tenantTransaction(this.prisma, (tx) =>
        tx.tenantOnboardingSkip.upsert({
          where: { tenantId_step: { tenantId: reseller.id, step } },
          create: { tenantId: reseller.id, step, skippedByUserId: actor.userId },
          update: {},
        }),
      ),
    );
  }

  /** The skip taken back: the step is open again until an import or another skip. */
  async unskip(actor: OnboardingActor, tenantId: string, step: TenantOnboardingOptionalStep): Promise<void> {
    await this.access.for('migration.manage').run(actor, tenantId, 'staffWrite', (reseller) =>
      tenantTransaction(this.prisma, (tx) => tx.tenantOnboardingSkip.deleteMany({ where: { tenantId: reseller.id, step } })),
    );
  }

  /**
   * The gate itself, in the same shape `TenantStatusListener` computes it: one
   * `verified` `panel` `custom_domain`. The two read the same rows on purpose —
   * a console that disagrees with the guard is worse than no console.
   */
  /**
   * Something to sell, by the catalog's own rule (F-018-ah): the platform's
   * offers the reseller inherits count as well as its own prices — only those
   * priced in the reseller's operating currency (F-116-d), and of the
   * platform's only what its package lists (F-019-v5).
   */
  private async somethingToSell(tenantId: string) {
    const [platformId, currencyCode, listed] = await Promise.all([
      platformTenantIdOf(this.all),
      operatingCurrencyOf(this.all, tenantId),
      platformProductsSoldBy(this.all, tenantId),
    ]);
    return this.all.productVariant.findFirst({ where: offeredToTenant(tenantId, platformId, new Date(), currencyCode, listed), select: { id: true } });
  }

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
