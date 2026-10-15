import { ConfirmationMode, Prisma } from '@prisma/client';

import type { PaymentProvider } from '../gateway/payment-provider';
import type { DestinationFields, ManualMethod } from './manual-method';
import { manualMethod, publicDestination } from './manual-methods';

/**
 * Starting a manual top-up (F-803-d, contract.manual-transfer.md "Starting
 * one"): which destination a payer is shown, what the gateway charges in,
 * how long the payer has, and the `transfer` body a start answers. The rest of
 * a start — pricing, coupons, the payment row — is every gateway's
 * (principle 1); this file adds only what a manual one needs on top.
 */

/** A late proof is still taken this long past the window, before the expiry sweep closes the payment (F-092-k). */
export const TRANSFER_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * What a gateway read carries for a manual gateway: its setting and its first
 * active destination by sort order — the one a start shows until rotation
 * (F-807). `null` on any other gateway. Selected with the gateway's columns,
 * so the list, the quote and the start read it once.
 */
export const TRANSFER_SELECT = {
  manualSetting: {
    select: {
      kind: true,
      confirmationMode: true,
      requiredProof: true,
      windowMinutes: true,
      destinations: {
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        take: 1,
        select: { id: true, fields: true },
      },
    },
  },
} as const satisfies Prisma.TenantGatewayConfigSelect & Prisma.PaymentGatewaySelect;

/** The part of a gateway read the manual rules look at. */
export type TransferGateway = {
  manualSetting?: {
    kind: string;
    confirmationMode: string;
    requiredProof: string[];
    windowMinutes: number;
    destinations: readonly { id: string; fields: unknown }[];
  } | null;
};

/** What a start on a manual gateway shows and records. */
export type TransferPlan = {
  method: ManualMethod;
  destinationId: string;
  fields: DestinationFields;
  confirmationMode: string;
  requiredProof: string[];
  windowMinutes: number;
};

/** The payment's charge: currency and minor-unit places. */
export type TransferCharge = { currency: string; decimals: number };

/** The `transfer` a start answers and `GET …/transfer` re-reads (dates as instants, the amount as a string — JSON has no bigint). */
export type TransferBody = {
  kind: string;
  destination: DestinationFields;
  amountMinor: string;
  currencyCode: string;
  decimals: number;
  windowEndsAt: Date;
  requiredProof: string[];
  confirmationMode: string;
};

/** The destination a start shows, or `null`: not a manual gateway, a kind no longer registered, or nothing active. */
export function transferPlanOf(gateway: TransferGateway): TransferPlan | null {
  const setting = gateway.manualSetting;
  const destination = setting?.destinations[0];
  const method = setting ? manualMethod(setting.kind) : undefined;
  if (!setting || !destination || !method) return null;
  return {
    method,
    destinationId: destination.id,
    fields: destination.fields as DestinationFields,
    confirmationMode: setting.confirmationMode,
    requiredProof: setting.requiredProof,
    windowMinutes: setting.windowMinutes,
  };
}

/**
 * What a gateway charges in: a manual one's destination's (a card rials, a
 * wallet its asset), any other its driver's. The one place both are read, so
 * a quote, a start and the currencies a tenant may pin agree (F-116-j).
 */
export function chargeOf(gateway: TransferGateway, provider: Pick<PaymentProvider, 'chargeCurrency' | 'chargeDecimals'>): TransferCharge {
  if (!gateway.manualSetting) return { currency: provider.chargeCurrency, decimals: provider.chargeDecimals };
  const plan = transferPlanOf(gateway);
  // Not offered without one (F-803-c), so reaching here is a caller's bug.
  if (!plan) throw new Error('a manual gateway with no active destination has no charge currency');
  return { currency: plan.method.chargeCurrency(plan.fields), decimals: plan.method.chargeDecimals(plan.fields) };
}

/**
 * Settles itself, for the deposit list's order (principle 4): every gateway
 * but a manual one confirmed by a person. A manual gateway in `automatic`
 * mode joins once it has a watcher (F-803-f) — gateway admin refuses the mode
 * until then (principle 7).
 */
export function isAutomatic(gateway: TransferGateway): boolean {
  return !gateway.manualSetting || gateway.manualSetting.confirmationMode === ConfirmationMode.automatic;
}

/** Gateways that settle themselves first, then the rest, each group in the order it came. */
export function automaticFirst<T extends TransferGateway>(gateways: readonly T[]): T[] {
  return [...gateways.filter(isAutomatic), ...gateways.filter((g) => !isAutomatic(g))];
}

/** The window the payer has, and the payment's clock: the window plus {@link TRANSFER_GRACE_MS}. */
export function transferWindow(plan: TransferPlan, now: Date): { windowEndsAt: Date; expiresAt: Date } {
  const windowEndsAt = new Date(now.getTime() + plan.windowMinutes * 60_000);
  return { windowEndsAt, expiresAt: new Date(windowEndsAt.getTime() + TRANSFER_GRACE_MS) };
}

/** The body a start answers: the destination's public fields, the exact charge, the window, what to send. */
export function transferBody(plan: TransferPlan, charge: TransferCharge, amountMinor: bigint, windowEndsAt: Date): TransferBody {
  return {
    kind: plan.method.kind,
    destination: publicDestination(plan.method, plan.fields),
    amountMinor: amountMinor.toString(),
    currencyCode: charge.currency,
    decimals: charge.decimals,
    windowEndsAt,
    requiredProof: plan.requiredProof,
    confirmationMode: plan.confirmationMode,
  };
}

/**
 * A start on a manual gateway, priced: the body it answers and the payment's
 * clock. `null` for any other gateway — and on the free path, which reaches
 * nobody, so the caller passes no charge.
 */
export function startTransfer(
  gateway: TransferGateway,
  charge: TransferCharge,
  chargedAmountMinor: bigint | null,
  now: Date,
): { plan: TransferPlan; body: TransferBody; expiresAt: Date } | null {
  const plan = transferPlanOf(gateway);
  if (!plan || chargedAmountMinor === null) return null;
  const { windowEndsAt, expiresAt } = transferWindow(plan, now);
  return { plan, body: transferBody(plan, charge, chargedAmountMinor, windowEndsAt), expiresAt };
}

/**
 * The `payment_transfer_detail` row a start writes beside its payment, in the
 * same transaction: what the payer was shown, frozen — editing the destination
 * later never changes an open payment (F-803-a). The amount is exactly the
 * quoted charge until F-804's unique amount.
 */
export function transferDetailData(paymentId: string, tenantId: string, body: TransferBody, destinationId: string): Prisma.PaymentTransferDetailUncheckedCreateInput {
  const network = body.destination['network'];
  return {
    paymentId,
    tenantId,
    destinationId,
    destinationSnapshot: body.destination,
    expectedAmountMinor: BigInt(body.amountMinor),
    chargeCurrency: body.currencyCode,
    chargeDecimals: body.decimals,
    // A wallet's network as the payer saw it; a card has none.
    network: typeof network === 'string' ? network : null,
    windowEndsAt: body.windowEndsAt,
  };
}
