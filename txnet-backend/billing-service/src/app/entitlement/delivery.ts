import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ActorType, ConfigStatus, FulfilmentKind, GrantSource, GrantStatus, InvoiceStatus, Prisma, WalletReasonType } from '@prisma/client';
import { OutboxEventType, productSaleRef, ResellerQuota, runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import type { EnvConfig } from '../config/env.validation';
import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigActionsService, ConfigActor } from '../traffic/config-actions';
import { GroupFulfilmentRefused, GroupFulfilmentService } from '../traffic/group-fulfilment';
import { releaseVpnReserveOf } from '../traffic/vpn-reserve';
import { WalletCreditService } from '../wallet/wallet-credit.service';
import { errorLine } from '../log-line';
import { GRANT_AGGREGATE, markDelivered } from './delivered';
import { PackageWholesale } from './package-wholesale';

/**
 * Delivery of a paid Grant — spec §5.8 step 3 (F-111-d).
 *
 * Step 2 (F-111-b) took the money and issued the Grant `pending`. This is the
 * rest: a handler chosen by the product's `fulfilmentKind` delivers it, and a
 * Grant that cannot be delivered is cancelled and its invoice refunded in full.
 *
 * **The handler is the kind** ({@link DELIVERY_ROUTE}). `feature_access` has
 * nothing to wait for and is delivered at the first check. `network_access`
 * is delivered by its panel group: group fulfilment places the configs and
 * activates the Grant once `minHealthyPanels` confirm it (network
 * `contract.groups.md` rule 10) — on this sweep's check or on its own
 * minute tick, whichever reads it first, both through `markDelivered`. A kind
 * with no handler — `external_order` and `wallet_topup` (both retired,
 * F-111-h / F-111-g: never created again), a network variant with
 * no group — is refunded at the first check: nothing an hour of retries does
 * can deliver it (the user's call, 2026-09-25), and the invoice refuses to
 * sell one in the first place (`sellableKind`, F-111-a).
 *
 * **The clock** is `deliveryAttempts` + `nextDeliveryAt` on the Grant: checked
 * at the first tick after payment, then after 1, 2, 4, 8, 16 and 32 minutes
 * (`GRANT_DELIVERY_RETRIES`, `GRANT_DELIVERY_FIRST_RETRY_MS`). The check after
 * the last retry that still finds it `pending` refunds it.
 *
 * **A refund is once, and whole.** One transaction: the Grant `pending ->
 * cancelled`, conditional on `pending` so a delivery that won the race is
 * never refunded; every config it was given retired (desired state — the pass
 * deletes the clients); the invoice `paid -> refunded` under its row lock; one
 * `product_refund` credit of `total` through `WalletCreditService`, so the
 * money revives what it funds like any credit (F-027-ap); and
 * `entitlement.grant.refunded` in the outbox. The coupon uses stay used — the
 * discount was not money the user paid, and `total` is what they did.
 *
 * **A purchase still waiting is announced once** (F-601-i): the first check
 * that finds it `pending` `GRANT_DELIVERY_DELAYED_AFTER_MS` after purchase
 * sets `deliveryDelayedAt` and writes `entitlement.grant.delivery_delayed` —
 * the buyer is told it is being prepared, the tenant's owner why
 * ({@link DeliveryDelay}). Only a check that leaves it waiting; one that
 * delivers or refunds it has its own notice.
 */

/** How a kind is delivered; `null` is no handler — refunded at the first check. */
export type DeliveryRoute = 'activate' | 'panel_group';

/** Exhaustive over the enum (C-09's habit): a new kind does not compile until somebody says how it is delivered. */
const DELIVERY_ROUTE: Record<FulfilmentKind, DeliveryRoute | null> = {
  [FulfilmentKind.feature_access]: 'activate',
  [FulfilmentKind.network_access]: 'panel_group',
  [FulfilmentKind.external_order]: null,
  [FulfilmentKind.wallet_topup]: null,
};

/** The handler for a variant, or `null`. A network variant is delivered only through a panel group. */
export function deliveryRouteOf(kind: FulfilmentKind, panelGroupId: string | null): DeliveryRoute | null {
  const route = DELIVERY_ROUTE[kind];
  if (route === 'panel_group' && !panelGroupId) return null;
  return route;
}

export type DeliveryPolicy = { retries: number; firstRetryMs: number };

/**
 * When the next check is due after `attempts` checks found the Grant
 * undelivered, or `null` to give up. The first check is the free one; retry
 * `n` waits `firstRetryMs * 2^(n-1)`.
 */
export function nextDeliveryAt(attempts: number, now: Date, policy: DeliveryPolicy): Date | null {
  if (attempts > policy.retries) return null;
  return new Date(now.getTime() + policy.firstRetryMs * 2 ** (attempts - 1));
}

/**
 * Declared once (C-09): why a paid Grant is still waiting, as its owner is told
 * (F-601-i). `panel_unavailable`: a panel owed a config cannot take one — not
 * accepted or not serving, nothing picked to sell, or full. `write_unconfirmed`:
 * every owed panel has its config and too few have confirmed it — a write the
 * panel refused, or one not read back yet. `strategy_not_built`: the group's
 * strategy has no fulfilment (network `contract.groups.md` rule 7).
 */
export const DELIVERY_DELAYS = ['panel_unavailable', 'write_unconfirmed', 'strategy_not_built'] as const;
export type DeliveryDelay = (typeof DELIVERY_DELAYS)[number];

/** Declared once (C-09): why a paid Grant was cancelled and refunded, written to `statusReason`. */
export const DELIVERY_FAILURES = ['no_delivery_route', 'delivery_timed_out'] as const;
export type DeliveryFailure = (typeof DELIVERY_FAILURES)[number];

/** A purchase still `pending` whose next check is due — the sweep's scan and the one-Grant check alike. */
export const dueForDelivery = (now: Date): Prisma.GrantWhereInput => ({
  status: GrantStatus.pending,
  source: GrantSource.purchase,
  OR: [{ nextDeliveryAt: null }, { nextDeliveryAt: { lte: now } }],
});

export type DeliveryOutcome = 'delivered' | 'waiting' | 'refunded' | 'skipped';
export type DeliverDueResult = { scanned: number; delivered: number; waiting: number; refunded: number; failed: number };

/** Who retired a refunded Grant's configs in `config_action_log`: the delivery sweep, one fixed id. */
export const GRANT_DELIVERY_ACTOR: ConfigActor = { actorType: ActorType.system, actorId: '00000000-0000-4000-8000-0000000f111d' };

@Injectable()
export class GrantDeliveryService {
  private readonly logger = new Logger(GrantDeliveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crossTenant: CrossTenantPrismaService,
    private readonly groups: GroupFulfilmentService,
    private readonly actions: ConfigActionsService,
    private readonly credits: WalletCreditService,
    private readonly config: ConfigService<EnvConfig, true>,
  ) {}

  /** Its ledger holds no state, so it needs no injection. */
  private readonly wholesale = new PackageWholesale();

  private get policy(): DeliveryPolicy {
    return {
      retries: this.config.get('GRANT_DELIVERY_RETRIES', { infer: true }),
      firstRetryMs: this.config.get('GRANT_DELIVERY_FIRST_RETRY_MS', { infer: true }),
    };
  }

  /** One check of one Grant, in the caller's tenant transaction. */
  async deliver(tx: Prisma.TransactionClient, grantId: string, now: Date): Promise<DeliveryOutcome> {
    const grant = await tx.grant.findUnique({
      where: { id: grantId },
      select: {
        status: true,
        deliveryAttempts: true,
        createdAt: true,
        deliveryDelayedAt: true,
        variant: { select: { panelGroupId: true, product: { select: { fulfilmentKind: true } } } },
      },
    });
    if (!grant || grant.status !== GrantStatus.pending) return 'skipped';

    const attempts = grant.deliveryAttempts + 1;
    const route = grant.variant ? deliveryRouteOf(grant.variant.product.fulfilmentKind, grant.variant.panelGroupId) : null;
    if (route === null) return this.refund(tx, grantId, attempts, 'no_delivery_route');

    if (route === 'activate') {
      return (await markDelivered(tx, grantId)) ? 'delivered' : 'skipped';
    }

    let delay: { reason: DeliveryDelay; waitingPanels: number };
    try {
      const fulfilment = await this.groups.fulfil(tx, grantId);
      if (fulfilment.activated) return 'delivered';
      const waitingPanels = fulfilment.waiting.length;
      delay = { reason: waitingPanels > 0 ? 'panel_unavailable' : 'write_unconfirmed', waitingPanels };
    } catch (e) {
      // A group set to a strategy with no fulfilment is an attempt that failed:
      // an operator may switch it back before the clock runs out.
      if (!(e instanceof GroupFulfilmentRefused) || e.reason !== 'strategy_not_built') throw e;
      delay = { reason: 'strategy_not_built', waitingPanels: 0 };
    }

    const next = nextDeliveryAt(attempts, now, this.policy);
    if (next === null) return this.refund(tx, grantId, attempts, 'delivery_timed_out');
    const moved = await tx.grant.updateMany({
      where: { id: grantId, status: GrantStatus.pending },
      data: { deliveryAttempts: attempts, nextDeliveryAt: next },
    });
    if (moved.count !== 1) return 'skipped';

    const delayedAfterMs = this.config.get('GRANT_DELIVERY_DELAYED_AFTER_MS', { infer: true });
    if (grant.deliveryDelayedAt === null && now.getTime() - grant.createdAt.getTime() >= delayedAfterMs) {
      await this.announceDelay(tx, grantId, now, delay);
    }
    return 'waiting';
  }

  /** F-601-i: once per Grant — the write that sets `deliveryDelayedAt` is the one that emits. */
  private async announceDelay(tx: Prisma.TransactionClient, grantId: string, now: Date, delay: { reason: DeliveryDelay; waitingPanels: number }): Promise<void> {
    const marked = await tx.grant.updateMany({
      where: { id: grantId, status: GrantStatus.pending, deliveryDelayedAt: null },
      data: { deliveryDelayedAt: now },
    });
    if (marked.count !== 1) return;

    const grant = await tx.grant.findUnique({ where: { id: grantId }, select: { tenantId: true, userId: true, sourceReferenceId: true } });
    if (!grant) return;
    const tenant = await tx.tenant.findUnique({ where: { id: grant.tenantId }, select: { ownerUserId: true } });
    await tx.outboxEvent.create({
      data: {
        aggregate: GRANT_AGGREGATE,
        aggregateId: grantId,
        type: OutboxEventType.GRANT_DELIVERY_DELAYED,
        payload: {
          tenantId: grant.tenantId,
          userId: grant.userId,
          grantId,
          invoiceId: grant.sourceReferenceId,
          ownerUserId: tenant?.ownerUserId ?? null,
          reason: delay.reason,
          waitingPanels: String(delay.waitingPanels),
        },
      },
      select: { id: true },
    });
  }

  private async refund(tx: Prisma.TransactionClient, grantId: string, attempts: number, reason: DeliveryFailure): Promise<DeliveryOutcome> {
    const cancelled = await tx.grant.updateMany({
      where: { id: grantId, status: GrantStatus.pending },
      data: { status: GrantStatus.cancelled, statusReason: reason, deliveryAttempts: attempts, nextDeliveryAt: null },
    });
    if (cancelled.count !== 1) return 'skipped';

    const grant = await tx.grant.findUnique({
      where: { id: grantId },
      select: { tenantId: true, userId: true, source: true, sourceReferenceId: true },
    });
    if (!grant || grant.source !== GrantSource.purchase || !grant.sourceReferenceId) {
      throw new Error(`grant ${grantId} is pending with no invoice to refund`);
    }

    // Held at issue for a metered Grant; a cancel gives it back before the refund (F-118-b).
    await releaseVpnReserveOf(tx, grantId);
    // A reseller's plan bought wholesale at the sale; never served, it all comes back (F-118-p).
    await this.wholesale.settleAtClose(tx, grantId);
    // Never served, the sale gives its package quota back, and any overage to the reseller's wallet (F-019-v6).
    await ResellerQuota.release(tx, { tenantId: grant.tenantId, sourceRef: productSaleRef(grantId) });
    const configs = await tx.config.findMany({ where: { grantId, status: { not: ConfigStatus.retired } }, select: { id: true } });
    for (const { id } of configs) await this.actions.retire(tx, { configId: id, actor: GRANT_DELIVERY_ACTOR });

    const [invoice] = await tx.$queryRaw<Array<{ id: string; userId: string; total: Prisma.Decimal; currencyCode: string; status: InvoiceStatus }>>`
      SELECT id, "userId", total, "currencyCode", status FROM billing.invoice WHERE id = ${grant.sourceReferenceId}::uuid FOR UPDATE`;
    if (!invoice) throw new Error(`invoice ${grant.sourceReferenceId} of grant ${grantId} not found`);
    const flipped = await tx.invoice.updateMany({ where: { id: invoice.id, status: InvoiceStatus.paid }, data: { status: InvoiceStatus.refunded } });
    // Anything but `paid` here is a second refund of one invoice: roll the cancel back with it.
    if (flipped.count !== 1) throw new Error(`invoice ${invoice.id} is ${invoice.status}, not paid: not refunded twice`);

    const total = new Prisma.Decimal(invoice.total);
    // A free invoice moved no money and writes no row (billing invariant 2).
    if (total.gt(0)) {
      await this.credits.credit(tx, { userId: invoice.userId, amount: total, currencyCode: invoice.currencyCode, reasonType: WalletReasonType.product_refund, referenceId: invoice.id });
    }

    await tx.outboxEvent.create({
      data: {
        aggregate: GRANT_AGGREGATE,
        aggregateId: grantId,
        type: OutboxEventType.GRANT_REFUNDED,
        payload: { tenantId: grant.tenantId, userId: grant.userId, grantId, invoiceId: invoice.id, amount: total.toFixed(2), reason },
      },
      select: { id: true },
    });
    return 'refunded';
  }

  /**
   * The same check for one Grant, the moment its purchase is announced
   * (F-114-i): `worker-service`'s `entitlement.grant.created` consumer. Only a
   * Grant the sweep would pick now is checked — a redelivered event, or one
   * the sweep beat to it, answers `skipped` and moves no clock. The tenant is
   * the Grant's own, read here, never the caller's.
   */
  async deliverNow(grantId: string, now: Date = new Date()): Promise<DeliveryOutcome> {
    const grant = await this.crossTenant.grant.findFirst({ where: { id: grantId, ...dueForDelivery(now) }, select: { id: true, tenantId: true } });
    if (!grant) return 'skipped';
    return runWithTenant({ id: grant.tenantId }, () => tenantTransaction(this.prisma, (tx) => this.deliver(tx, grant.id, now)));
  }

  /**
   * One sweep, for `worker-service`'s `grant_delivery` tick. The scan is the
   * `pending` purchases whose check is due, oldest first, cross-tenant; each
   * check runs in its own tenant transaction, so one Grant's failure is its
   * own and it is named again next tick, its clock unmoved.
   */
  async deliverDue(now: Date = new Date()): Promise<DeliverDueResult> {
    const due = await this.crossTenant.grant.findMany({
      where: dueForDelivery(now),
      select: { id: true, tenantId: true },
      orderBy: { createdAt: 'asc' },
      take: this.config.get('PAYMENT_EXPIRY_BATCH_SIZE', { infer: true }),
    });

    const result: DeliverDueResult = { scanned: due.length, delivered: 0, waiting: 0, refunded: 0, failed: 0 };
    for (const grant of due) {
      try {
        const outcome = await runWithTenant({ id: grant.tenantId }, () => tenantTransaction(this.prisma, (tx) => this.deliver(tx, grant.id, now)));
        if (outcome !== 'skipped') result[outcome] += 1;
      } catch (e) {
        result.failed += 1;
        this.logger.warn(`delivery of grant ${grant.id} failed: ${errorLine(e)}`);
      }
    }
    if (result.delivered > 0 || result.refunded > 0) {
      this.logger.log(`delivered ${result.delivered}, refunded ${result.refunded} of ${due.length} paid Grant(s)`);
    }
    return result;
  }
}
