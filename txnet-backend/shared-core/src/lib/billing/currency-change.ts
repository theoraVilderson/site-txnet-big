import { randomUUID } from 'node:crypto';

import { AdminAction, AuditTargetType, Prisma, type TenantType } from '@prisma/client';

import { OutboxEventType } from '../automation/routing-keys';
import type { FxPair } from '../currency/fx-rate';
import { isPlatformTenant } from '../tenant/platform-tenant';

import {
  convertBillingWallets,
  convertPackages,
  convertQuotaOverages,
  convertUsageMeters,
  convertWholesaleMeters,
  repricePackageRates,
} from './currency-change-platform';
import { balance, type Conversion, money, moneyList, owned, RATE_COLUMN_SCALE } from './currency-change-sql';
import { roundRate } from './money-rounding';

/**
 * F-116-f (ADR-0098 part 5) — a tenant's operating currency changes, and what
 * is live changes with it; history keeps the currency it was written in.
 *
 * **One rate, one transaction.** The caller reads the pair (`readFxPair`,
 * old -> new) and opens the transaction; everything below is set-based SQL
 * inside it, so a tenant's money is all in the old currency or all in the new
 * one (user, 2026-09-28). The rate is rounded to 18 places once, stored on the
 * `billing.currency_change` row, and is the rate every amount is converted at.
 *
 * **Live, converted:**
 * - every wallet of the tenant's users in the old currency: a `currency_change`
 *   debit of its balance (old currency, to zero), the wallet relabelled and
 *   its balance converted — a positive one never to nothing (ADR-0153) — and a
 *   `currency_change` credit of the new balance. An empty wallet only changes
 *   its label. Its open holds and `heldAmount`
 *   convert with it, rounded down (F-118-a) — no ledger row: a hold is not one;
 * - the price and metered rate in effect for each variant, and every one
 *   scheduled after it: a **new** row in the new currency (a price is never
 *   updated, F-0602) from now, or from its own scheduled date;
 * - a live Grant's locked metered rate (it debits the converted wallet);
 * - coupon amounts (a fixed or gift value, the cap, the purchase bounds — a
 *   percentage stays), fixed-amount rules, deposit presets, and each gateway's
 *   limits, fixed fee, fee floor/ceiling and presets. A gateway's rate columns
 *   (`staticRate`, `fixedAmountModifier`, `minRate`, `maxRate`) are charge
 *   units per unit of the tenant's currency, so they are divided; its
 *   `roundingStep` is in charge units and stays;
 * - an invoice still on its 30-minute clock is cancelled and its coupon holds
 *   given back (user, 2026-09-28): it is a quote in the old currency;
 * - the platform's change also converts every reseller's billing wallet (the
 *   same closing / opening pair), the packages it sells them and unbilled
 *   usage (part 4).
 *
 * **History, untouched:** ledger rows, earlier price rows, paid and closed
 * invoices, payments, settlement entries, closed Grants.
 *
 * **In flight:** a payment asked in the old currency is not rewritten. When it
 * settles, the ledger sees a credit in another currency than the wallet's and
 * converts it through this row (`convertedByChanges`, `currency-change-credit.ts`).
 *
 * **Safe to retry:** the tenant row is locked first and its currency re-read;
 * a tenant already in the target currency is a no-op (`changeId: null`), and
 * one no longer in the pair's `fromCode` is refused ({@link CurrencyChangeConflict}).
 *
 * `tx` is a transaction on the cross-tenant pool (`txnet_cross_tenant_user`):
 * the change spans every user and, for the platform, every reseller.
 */
export type CurrencyChangeInput = {
  tenantId: string;
  toCode: string;
  /** Old -> new, as `readFxPair` returned it. */
  pair: FxPair;
  actorUserId: string;
  actorIp: string;
};

export type CurrencyChangeSummary = {
  wallets: number;
  prices: number;
  /** Rate cards repriced (F-118-d). The key predates them; the panel reads it. */
  meteredRates: number;
  /** Open Grants' meters converted (F-118-l). The key predates them. */
  grants: number;
  /** Spending caps (F-118-i): the cap and what it has counted, with their wallet. */
  spendingCaps: number;
  coupons: number;
  rules: number;
  depositSettings: number;
  gateways: number;
  invoicesCancelled: number;
  billingWallets: number;
  packages: number;
  /** The platform's wholesale rates in force (F-118-n1), written again in the new money. */
  packageRates: number;
  /** Open reseller Grants' wholesale legs (F-118-n2), converted with the platform's money. */
  wholesaleMeters: number;
  usageMeters: number;
  /** Quota overage prices at the platform's, packages' and resellers' levels (F-019-v1), and resellers' overage caps (F-019-v2). */
  quotaOverages: number;
};

export type CurrencyChangeOutcome = {
  /** `null` when the tenant was already in `toCode`: nothing was written. */
  changeId: string | null;
  fromCode: string;
  toCode: string;
  /** The rate everything was converted at, as stored. */
  rate: string;
  summary: CurrencyChangeSummary | null;
};

/** The tenant's currency is no longer the pair's `fromCode`: another change won. Re-read the rate and retry. */
export class CurrencyChangeConflict extends Error {
  constructor(readonly tenantId: string, readonly current: string, readonly expected: string) {
    super(`tenant ${tenantId} is in ${current}, not ${expected}; re-read the rate`);
    this.name = 'CurrencyChangeConflict';
  }
}

/** `rate` is stored as `DECIMAL(30,18)` — the same scale as a payment's (F-116-e). */
const RATE_SCALE = 18;
/**
 * A gateway's rate columns are `DECIMAL(30,18)`: divided by the rate, an
 * inverse pair (USD -> IRR) lands near 1e-6 and needs the places.
 */
const GATEWAY_RATE_SCALE = 18;

export async function convertOperatingCurrency(
  tx: Prisma.TransactionClient,
  input: CurrencyChangeInput,
): Promise<CurrencyChangeOutcome> {
  const { tenantId, toCode, pair } = input;
  if (pair.toCode !== toCode) throw new Error(`rate pair ends in ${pair.toCode}, the change in ${toCode}`);
  const rate = roundRate(pair.rate, RATE_SCALE);

  const [tenant] = await tx.$queryRaw<Array<{ code: string; type: TenantType }>>`
    SELECT "operatingCurrencyCode" AS code, "tenantType" AS type FROM tenant.tenant WHERE id = ${tenantId}::uuid FOR UPDATE`;
  if (!tenant) throw new Error(`tenant ${tenantId} not found changing its currency`);
  if (tenant.code === toCode) return { changeId: null, fromCode: toCode, toCode, rate: '1', summary: null };
  if (tenant.code !== pair.fromCode) throw new CurrencyChangeConflict(tenantId, tenant.code, pair.fromCode);

  const target = await tx.currency.findUnique({ where: { code: toCode }, select: { decimalPlaces: true } });
  if (!target) throw new Error(`currency ${toCode} has no row`);

  const changeId = randomUUID();
  await tx.currencyChange.create({
    data: {
      id: changeId,
      tenantId,
      fromCode: pair.fromCode,
      toCode,
      rate,
      fromSnapshotId: pair.from?.snapshotId ?? null,
      toSnapshotId: pair.to?.snapshotId ?? null,
      changedByUserId: input.actorUserId,
    },
  });

  const c: Conversion = {
    tx,
    tenantId,
    changeId,
    from: pair.fromCode,
    to: toCode,
    rate: rate.toString(),
    dp: target.decimalPlaces,
    platform: isPlatformTenant(tenant.type),
    actor: input.actorUserId,
  };
  const summary: CurrencyChangeSummary = {
    wallets: await convertWallets(c),
    prices: await repricePrices(c),
    meteredRates: await repriceRateCards(c),
    grants: await convertGrants(c),
    spendingCaps: await convertSpendingCaps(c),
    coupons: await convertCoupons(c),
    rules: await convertRules(c),
    depositSettings: await convertDepositSettings(c),
    gateways: await convertGateways(c),
    invoicesCancelled: await cancelPendingInvoices(c),
    billingWallets: c.platform ? await convertBillingWallets(c) : 0,
    packages: c.platform ? await convertPackages(c) : 0,
    packageRates: c.platform ? await repricePackageRates(c) : 0,
    wholesaleMeters: c.platform ? await convertWholesaleMeters(c) : 0,
    usageMeters: c.platform ? await convertUsageMeters(c) : 0,
    quotaOverages: c.platform ? await convertQuotaOverages(c) : 0,
  };

  await tx.$executeRaw`UPDATE tenant.tenant SET "operatingCurrencyCode" = ${toCode}, "updatedAt" = now() WHERE id = ${tenantId}::uuid`;
  await tx.currencyChange.update({ where: { id: changeId }, data: { summary } });
  await tx.adminAuditLog.create({
    data: {
      tenantId,
      adminId: input.actorUserId,
      action: AdminAction.tenant_currency_change,
      targetEntityType: AuditTargetType.tenant,
      targetEntityId: tenantId,
      oldValue: { code: pair.fromCode },
      newValue: { code: toCode, rate: rate.toString(), changeId, summary },
      adminIpAddress: input.actorIp,
    },
  });
  return { changeId, fromCode: pair.fromCode, toCode, rate: rate.toString(), summary };
}

async function convertWallets(c: Conversion): Promise<number> {
  const scope = Prisma.sql`u."tenantId" = ${c.tenantId}::uuid AND w."currencyCode" = ${c.from}`;
  // Lock first: the closing row must carry the balance the update then converts.
  await c.tx.$queryRaw`
    SELECT count(*)::int AS n FROM (
      SELECT 1 FROM billing.wallet w JOIN identity."user" u ON u.id = w."ownerUserId" WHERE ${scope} FOR UPDATE OF w) locked`;
  // `clock_timestamp()`, not `now()`: the closing row sorts before the opening one.
  await c.tx.$executeRaw`
    INSERT INTO billing.wallet_transaction (id, "walletId", "tenantId", amount, direction, "reasonType", "referenceId", "balanceAfter", "currencyCode", "createdAt")
    SELECT gen_random_uuid(), w.id, u."tenantId", w."cachedBalance", 'debit'::billing."LedgerDirection", 'currency_change'::billing."WalletReasonType", ${c.changeId}::uuid, 0, w."currencyCode", clock_timestamp()
      FROM billing.wallet w JOIN identity."user" u ON u.id = w."ownerUserId"
     WHERE ${scope} AND w."cachedBalance" > 0`;
  // Open holds (F-118-a) convert with their wallet, each rounded **down**: the
  // sum of the parts then never exceeds the rounded balance, so
  // `cachedBalance - heldAmount >= 0` survives the change, and what rounding
  // takes is locked money handed back to the free balance, never taken from it.
  // A closed hold is history (invariant 19) and keeps its currency.
  await c.tx.$executeRaw`
    UPDATE billing.wallet_hold h
       SET amount = trunc(h.amount * ${c.rate}::numeric, ${c.dp}::int),
           captured = trunc(h.captured * ${c.rate}::numeric, ${c.dp}::int),
           "currencyCode" = ${c.to}
      FROM billing.wallet w JOIN identity."user" u ON u.id = w."ownerUserId"
     WHERE h."walletId" = w.id AND h.status = 'open' AND ${scope}`;
  const wallets = await c.tx.$executeRaw`
    UPDATE billing.wallet w
       SET "currencyCode" = ${c.to}, "cachedBalance" = ${balance(c, Prisma.sql`w."cachedBalance"`)},
           "heldAmount" = (SELECT coalesce(sum(h.amount), 0) FROM billing.wallet_hold h WHERE h."walletId" = w.id AND h.status = 'open'),
           version = w.version + 1
      FROM identity."user" u
     WHERE u.id = w."ownerUserId" AND ${scope}`;
  // Every opened wallet is announced, as the ledger announces any movement (F-111-m).
  await c.tx.$executeRaw`
    WITH opening AS (
      INSERT INTO billing.wallet_transaction (id, "walletId", "tenantId", amount, direction, "reasonType", "referenceId", "balanceAfter", "currencyCode", "createdAt")
      SELECT gen_random_uuid(), w.id, closing."tenantId", w."cachedBalance", 'credit'::billing."LedgerDirection", 'currency_change'::billing."WalletReasonType", ${c.changeId}::uuid, w."cachedBalance", w."currencyCode", clock_timestamp()
        FROM billing.wallet_transaction closing JOIN billing.wallet w ON w.id = closing."walletId"
       WHERE closing."referenceId" = ${c.changeId}::uuid AND closing."reasonType" = 'currency_change' AND closing.direction = 'debit'
         AND w."cachedBalance" > 0
      RETURNING id, "walletId", "tenantId"
    )
    INSERT INTO automation.outbox_event (id, aggregate, "aggregateId", type, payload)
    SELECT gen_random_uuid(), 'billing.wallet', o."walletId"::text, ${OutboxEventType.WALLET_CHANGED},
           jsonb_build_object('tenantId', o."tenantId", 'userId', w."ownerUserId", 'walletTransactionId', o.id)
      FROM opening o JOIN billing.wallet w ON w.id = o."walletId"`;
  return wallets;
}

/** For each variant: the row in effect now and every one scheduled after it, as new rows. */
function repriceRows(c: Conversion, table: Prisma.Sql, value: Prisma.Sql, converted: Prisma.Sql) {
  return c.tx.$executeRaw`
    INSERT INTO ${table} (id, "tenantId", "variantId", ${value}, "currencyCode", "effectiveFrom", "isActive", "createdByAdminId", "createdAt")
    SELECT gen_random_uuid(), p."tenantId", p."variantId", ${converted}, ${c.to}, greatest(p."effectiveFrom", now()), true, ${c.actor}::uuid, now()
      FROM ${table} p
     WHERE ${owned(c, Prisma.sql`p."tenantId"`)} AND p."currencyCode" = ${c.from} AND p."isActive"
       AND (p."effectiveFrom" > now() OR p."effectiveFrom" = (
             SELECT max(q."effectiveFrom") FROM ${table} q
              WHERE q."variantId" = p."variantId" AND q."currencyCode" = ${c.from} AND q."isActive" AND q."effectiveFrom" <= now()))`;
}

const repricePrices = (c: Conversion) =>
  repriceRows(c, Prisma.sql`catalog.price`, Prisma.sql`amount`, money(c, Prisma.sql`p.amount`));

/**
 * A rate card is repriced as a price is, per meter: the card in effect now and
 * every one scheduled after it, as new cards — everything but the price and its
 * currency copied (F-118-d). `metered_rate` is read by nothing since then.
 */
const repriceRateCards = (c: Conversion) => c.tx.$executeRaw`
  INSERT INTO catalog.rate_card (id, "tenantId", "variantId", "meterKey", "unitSize", "unitPrice", "currencyCode", mode,
                                 "includedQuantity", "afterIncluded", "effectiveFrom", "isActive", "createdByAdminId", "createdAt")
  SELECT gen_random_uuid(), p."tenantId", p."variantId", p."meterKey", p."unitSize",
         round(p."unitPrice" * ${c.rate}::numeric, ${RATE_COLUMN_SCALE}::int), ${c.to}, p.mode,
         p."includedQuantity", p."afterIncluded", greatest(p."effectiveFrom", now()), true, ${c.actor}::uuid, now()
    FROM catalog.rate_card p
   WHERE ${owned(c, Prisma.sql`p."tenantId"`)} AND p."currencyCode" = ${c.from} AND p."isActive"
     AND (p."effectiveFrom" > now() OR p."effectiveFrom" = (
           SELECT max(q."effectiveFrom") FROM catalog.rate_card q
            WHERE q."variantId" = p."variantId" AND q."meterKey" = p."meterKey" AND q."currencyCode" = ${c.from}
              AND q."isActive" AND q."effectiveFrom" <= now()))`;

/**
 * A Grant not yet closed keeps charging at its locked rate, so each of its
 * meters' price follows its wallet (F-118-l): the same price in the new
 * money, the one change `grant_meter_terms_are_locked` allows.
 */
const convertGrants = (c: Conversion) => c.tx.$executeRaw`
  UPDATE entitlement.grant_meter m
     SET "unitPrice" = round(m."unitPrice" * ${c.rate}::numeric, ${RATE_COLUMN_SCALE}::int), "currencyCode" = ${c.to}, "updatedAt" = now()
    FROM entitlement."grant" g
   WHERE g.id = m."grantId" AND m."tenantId" = ${c.tenantId}::uuid AND m."currencyCode" = ${c.from}
     AND g.status IN ('pending', 'active', 'suspended', 'exhausted')`;

/**
 * A spending cap is in its wallet's currency (F-118-i), so it converts with
 * it: the cap rounded to the new decimals, what it counted rounded **down** —
 * the owner's room never shrinks by the rounding.
 */
const convertSpendingCaps = (c: Conversion) => c.tx.$executeRaw`
  UPDATE billing.spending_cap
     SET amount = greatest(${money(c, Prisma.sql`amount`)}, power(10::numeric, -${c.dp}::int)),
         spent = trunc(spent * ${c.rate}::numeric, ${c.dp}::int),
         "currencyCode" = ${c.to}, "updatedAt" = now()
   WHERE "tenantId" = ${c.tenantId}::uuid AND "currencyCode" = ${c.from}`;

const convertCoupons = (c: Conversion) => c.tx.$executeRaw`
  UPDATE billing.coupon
     SET "discountValue" = CASE WHEN "discountType" IN ('fixed_amount', 'wallet_credit') THEN ${money(c, Prisma.sql`"discountValue"`)} ELSE "discountValue" END,
         "maxDiscountCap" = ${money(c, Prisma.sql`"maxDiscountCap"`)},
         "minPurchaseAmount" = ${money(c, Prisma.sql`"minPurchaseAmount"`)},
         "maxPurchaseAmount" = ${money(c, Prisma.sql`"maxPurchaseAmount"`)},
         "currencyCode" = ${c.to}, "updatedAt" = now()
   WHERE ${owned(c, Prisma.sql`"tenantId"`)} AND "currencyCode" = ${c.from} AND "deletedAt" IS NULL`;

const convertRules = (c: Conversion) => c.tx.$executeRaw`
  UPDATE billing.discount_rule
     SET value = CASE WHEN kind = 'fixed_amount' THEN ${money(c, Prisma.sql`value`)} ELSE value END,
         "currencyCode" = ${c.to}, "updatedAt" = now()
   WHERE "tenantId" = ${c.tenantId}::uuid AND "currencyCode" = ${c.from}`;

const convertDepositSettings = (c: Conversion) => c.tx.$executeRaw`
  UPDATE billing.deposit_setting
     SET presets = ${moneyList(c, Prisma.sql`presets`)}, "currencyCode" = ${c.to}, "updatedAt" = now()
   WHERE "tenantId" = ${c.tenantId}::uuid AND "currencyCode" = ${c.from}`;

/** The columns a tenant's gateway config and a platform gateway share. */
const gatewaySet = (c: Conversion) => Prisma.sql`
  "minAcceptAmount" = ${money(c, Prisma.sql`"minAcceptAmount"`)},
  "maxAcceptAmount" = ${money(c, Prisma.sql`"maxAcceptAmount"`)},
  "feeValue" = CASE WHEN "feeType" = 'fixed' THEN ${money(c, Prisma.sql`"feeValue"`)} ELSE "feeValue" END,
  "feeFloor" = ${money(c, Prisma.sql`"feeFloor"`)},
  "feeCeiling" = ${money(c, Prisma.sql`"feeCeiling"`)},
  "depositPresets" = ${moneyList(c, Prisma.sql`"depositPresets"`)},
  "staticRate" = round("staticRate" / ${c.rate}::numeric, ${GATEWAY_RATE_SCALE}::int),
  "fixedAmountModifier" = round("fixedAmountModifier" / ${c.rate}::numeric, ${GATEWAY_RATE_SCALE}::int),
  "minRate" = round("minRate" / ${c.rate}::numeric, ${GATEWAY_RATE_SCALE}::int),
  "maxRate" = round("maxRate" / ${c.rate}::numeric, ${GATEWAY_RATE_SCALE}::int),
  "currencyCode" = ${c.to}, "updatedAt" = now()`;

async function convertGateways(c: Conversion): Promise<number> {
  const own = await c.tx.$executeRaw`
    UPDATE tenant.tenant_gateway_config SET ${gatewaySet(c)} WHERE "tenantId" = ${c.tenantId}::uuid AND "currencyCode" = ${c.from}`;
  if (!c.platform) return own;
  return own + (await c.tx.$executeRaw`UPDATE billing.payment_gateway SET ${gatewaySet(c)} WHERE "currencyCode" = ${c.from}`);
}

/** A pending invoice is a quote in the old currency: cancelled, its holds given back as `settle_coupon_redemptions` does. */
async function cancelPendingInvoices(c: Conversion): Promise<number> {
  const [{ n }] = await c.tx.$queryRaw<Array<{ n: number }>>`
    WITH cancelled AS (
      UPDATE billing.invoice SET status = 'cancelled', "updatedAt" = now()
       WHERE "tenantId" = ${c.tenantId}::uuid AND status = 'pending'
      RETURNING id
    ), released AS (
      UPDATE billing.coupon_redemption r SET status = 'cancelled'
        FROM cancelled i WHERE r."orderReferenceId" = i.id AND r.status = 'pending'
      RETURNING r."couponId"
    ), per_coupon AS (
      SELECT "couponId", count(*)::int AS n FROM released GROUP BY "couponId"
    ), counted AS (
      UPDATE billing.coupon k SET "reservedCount" = k."reservedCount" - p.n FROM per_coupon p WHERE k.id = p."couponId" RETURNING k.id
    )
    SELECT (SELECT count(*) FROM cancelled)::int AS n`;
  return n;
}
