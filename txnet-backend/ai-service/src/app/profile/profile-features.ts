import type { GrantSource, GrantStatus, LedgerDirection, PaymentStatus, Prisma, VariantBillingMode, WalletReasonType } from '@prisma/client';
import { moneyText } from '@txnet-backend/shared-core';

import { activeHours } from './active-hours';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** How far back the builder reads anything (ADR-0109 point 14): raw behaviour is kept 180 days. */
export const PROFILE_HISTORY_DAYS = 180;
/** The short window: sign-ins, reads and hours of use "lately". */
export const PROFILE_RECENT_DAYS = 30;

/** Bump when a feature changes meaning, so a reader can tell an old profile from a new one. */
export const PROFILE_FEATURES_VERSION = 1;

const ENDED: ReadonlySet<GrantStatus> = new Set<GrantStatus>(['expired', 'exhausted', 'cancelled']);

/**
 * Everything the builder read about one account, already scoped to its tenant
 * and to {@link PROFILE_HISTORY_DAYS}. Shapes, not Prisma rows: the views are
 * read with raw SQL, and the predictions (F-038-d) read the same object.
 */
export type AccountInputs = {
  userId: string;
  createdAt: Date;
  grants: Array<{
    id: string;
    variantId: string | null;
    source: GrantSource;
    status: GrantStatus;
    billingMode: VariantBillingMode;
    trafficUnlimited: boolean;
    purchasedBytes: bigint;
    consumedBytes: bigint;
    usagePeriodFromBytes: bigint;
    startsAt: Date;
    activatedAt: Date | null;
    endsAt: Date | null;
    updatedAt: Date;
  }>;
  renewals: Array<{
    grantId: string;
    createdAt: Date;
    plan: boolean;
    bytes: bigint;
    endsAtBefore: Date | null;
    endsAtAfter: Date | null;
  }>;
  /** `ai.meter_reading` rows; a `delta` of 0 is a baseline, not a use. */
  readings: Array<{ grantId: string; meterKey: string; hour: Date; delta: bigint }>;
  walletTransactions: Array<{ direction: LedgerDirection; reasonType: WalletReasonType; createdAt: Date }>;
  wallet: { id: string; balance: Prisma.Decimal; held: Prisma.Decimal; currencyCode: string } | null;
  payments: Array<{ status: PaymentStatus; createdAt: Date; discountApplied: Prisma.Decimal }>;
  /** `ai.reader_sign_in.issuedAt` — a refresh rotates the row, so this is activity, not only logins. */
  signIns: Date[];
  notices: Array<{ createdAt: Date; readAt: Date | null }>;
};

/** `account_profile.features`. JSON-safe: dates are ISO strings, money a decimal string with its currency (C-02). */
export type AccountFeatures = {
  version: number;
  accountAgeDays: number;
  grants: {
    active: number;
    trialActive: boolean;
    total: number;
    everPurchased: boolean;
    nextEndsAt: string | null;
    lastEndedAt: string | null;
  };
  renewals180d: number;
  usage: { hoursUsed30d: number; lastUsedAt: string | null };
  wallet: { available: string; currencyCode: string } | null;
  topUps180d: number;
  payments: { succeeded180d: number; failed180d: number; couponUsed180d: number; lastSucceededAt: string | null };
  signIns: { last30d: number; lastAt: string | null };
  notices: { delivered30d: number; read30d: number };
  lastActiveAt: string | null;
};

/** When an ended Grant stopped: its end date, unless it ran out or was cancelled first. */
export function grantEndedAt(g: AccountInputs['grants'][number]): Date {
  return g.endsAt && g.endsAt.getTime() <= g.updatedAt.getTime() ? g.endsAt : g.updatedAt;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const latest = (dates: readonly Date[]): Date | null =>
  dates.reduce<Date | null>((a, b) => (a === null || b.getTime() > a.getTime() ? b : a), null);

/**
 * One account's profile (F-038-c): its features and its 168 active hours.
 * Pure — the builder reads, this decides, and the same inputs always give the
 * same profile. Active hours count a use (an hour a meter grew), a sign-in, a
 * notice read and a successful payment; a baseline reading is not a use.
 */
export function accountFeatures(input: AccountInputs, now: Date): { features: AccountFeatures; activeHours: number[] } {
  const since = (days: number) => now.getTime() - days * DAY_MS;
  const within = (at: Date, days: number) => at.getTime() > since(days) && at.getTime() <= now.getTime();

  const active = input.grants.filter((g) => g.status === 'active');
  const ended = input.grants.filter((g) => ENDED.has(g.status));
  const nextEnd = active
    .map((g) => g.endsAt)
    .filter((d): d is Date => d !== null && d.getTime() > now.getTime())
    .reduce<Date | null>((a, b) => (a === null || b.getTime() < a.getTime() ? b : a), null);

  const used = input.readings.filter((r) => r.delta > BigInt(0)).map((r) => r.hour);
  const succeeded = input.payments.filter((p) => p.status === 'success' && within(p.createdAt, PROFILE_HISTORY_DAYS));
  const reads = input.notices.map((n) => n.readAt).filter((d): d is Date => d !== null);
  const activity = [...used, ...input.signIns, ...reads, ...succeeded.map((p) => p.createdAt)];

  const features: AccountFeatures = {
    version: PROFILE_FEATURES_VERSION,
    accountAgeDays: Math.floor((now.getTime() - input.createdAt.getTime()) / DAY_MS),
    grants: {
      active: active.length,
      trialActive: active.some((g) => g.source === 'trial'),
      total: input.grants.length,
      everPurchased: input.grants.some((g) => g.source === 'purchase'),
      nextEndsAt: iso(nextEnd),
      lastEndedAt: iso(latest(ended.map(grantEndedAt))),
    },
    renewals180d: input.renewals.filter((r) => within(r.createdAt, PROFILE_HISTORY_DAYS)).length,
    usage: {
      hoursUsed30d: new Set(used.filter((h) => within(h, PROFILE_RECENT_DAYS)).map((h) => h.getTime())).size,
      lastUsedAt: iso(latest(used)),
    },
    wallet: input.wallet && {
      available: moneyText(input.wallet.balance.minus(input.wallet.held)),
      currencyCode: input.wallet.currencyCode,
    },
    topUps180d: input.walletTransactions.filter(
      (t) => t.direction === 'credit' && t.reasonType === 'payment_gateway' && within(t.createdAt, PROFILE_HISTORY_DAYS),
    ).length,
    payments: {
      succeeded180d: succeeded.length,
      failed180d: input.payments.filter((p) => p.status === 'failed' && within(p.createdAt, PROFILE_HISTORY_DAYS)).length,
      couponUsed180d: succeeded.filter((p) => p.discountApplied.gt(0)).length,
      lastSucceededAt: iso(latest(succeeded.map((p) => p.createdAt))),
    },
    signIns: {
      last30d: input.signIns.filter((d) => within(d, PROFILE_RECENT_DAYS)).length,
      lastAt: iso(latest(input.signIns)),
    },
    notices: {
      delivered30d: input.notices.filter((n) => within(n.createdAt, PROFILE_RECENT_DAYS)).length,
      read30d: input.notices.filter((n) => within(n.createdAt, PROFILE_RECENT_DAYS) && n.readAt !== null).length,
    },
    lastActiveAt: iso(latest(activity)),
  };
  return { features, activeHours: activeHours(activity, now) };
}
