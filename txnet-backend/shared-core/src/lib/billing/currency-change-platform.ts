import { Prisma } from '@prisma/client';

import { balance, type Conversion, money, RATE_COLUMN_SCALE } from './currency-change-sql';

/**
 * What only the platform's currency change converts (ADR-0098 part 4): its
 * resellers' billing wallets, the packages and wholesale rates it sells them,
 * unbilled usage and quota overage. Called from `convertOperatingCurrency`,
 * in its transaction, when the tenant changing is the platform.
 */

/** Every reseller's wallet with the platform (part 4): the same closing / opening pair as a user's. */
export async function convertBillingWallets(c: Conversion): Promise<number> {
  await c.tx.$queryRaw`
    SELECT count(*)::int AS n FROM (SELECT 1 FROM tenant.tenant_billing_wallet WHERE "currencyCode" = ${c.from} FOR UPDATE) locked`;
  await c.tx.$executeRaw`
    INSERT INTO tenant.tenant_billing_transaction (id, "walletId", amount, direction, "reasonType", "referenceId", "balanceAfter", "currencyCode", "createdAt")
    SELECT gen_random_uuid(), id, "cachedBalance", 'debit'::tenant."TenantLedgerDirection", 'currency_change'::tenant."TenantBillingReasonType", ${c.changeId}::uuid, 0, "currencyCode", clock_timestamp()
      FROM tenant.tenant_billing_wallet WHERE "currencyCode" = ${c.from} AND "cachedBalance" > 0`;
  const wallets = await c.tx.$executeRaw`
    UPDATE tenant.tenant_billing_wallet
       SET "currencyCode" = ${c.to}, "cachedBalance" = ${balance(c, Prisma.sql`"cachedBalance"`)}, version = version + 1
     WHERE "currencyCode" = ${c.from}`;
  // No `tenant.billing.credited` event: nothing was paid in, so no unpaid renewal should be retried on it.
  await c.tx.$executeRaw`
    INSERT INTO tenant.tenant_billing_transaction (id, "walletId", amount, direction, "reasonType", "referenceId", "balanceAfter", "currencyCode", "createdAt")
    SELECT gen_random_uuid(), w.id, w."cachedBalance", 'credit'::tenant."TenantLedgerDirection", 'currency_change'::tenant."TenantBillingReasonType", ${c.changeId}::uuid, w."cachedBalance", w."currencyCode", clock_timestamp()
      FROM tenant.tenant_billing_transaction closing JOIN tenant.tenant_billing_wallet w ON w.id = closing."walletId"
     WHERE closing."referenceId" = ${c.changeId}::uuid AND closing."reasonType" = 'currency_change' AND closing.direction = 'debit'
       AND w."cachedBalance" > 0`;
  return wallets;
}

/** The packages the platform sells its resellers, priced again in the new money. */
export const convertPackages = (c: Conversion) => c.tx.$executeRaw`
  UPDATE tenant.tenant_feature_package
     SET "monthlyPrice" = ${money(c, Prisma.sql`"monthlyPrice"`)}, "yearlyPrice" = ${money(c, Prisma.sql`"yearlyPrice"`)}, "currencyCode" = ${c.to}
   WHERE "currencyCode" = ${c.from}`;

/**
 * The wholesale price list (F-118-n1) is history, like a rate card: each rate
 * in force in the old money is written again in the new one, from now, and the
 * old row stays — read by nothing, since a package reads rates in its own
 * currency. Never rounded to nothing: the smallest price the column holds.
 */
export const repricePackageRates = (c: Conversion) => c.tx.$executeRaw`
  INSERT INTO tenant.tenant_package_meter_rate (id, "packageId", "meterKey", "unitSize", "unitPrice", "currencyCode",
                                                "effectiveFrom", "isActive", "createdByAdminId", "createdAt")
  SELECT gen_random_uuid(), p."packageId", p."meterKey", p."unitSize",
         greatest(round(p."unitPrice" * ${c.rate}::numeric, ${RATE_COLUMN_SCALE}::int), power(10::numeric, -${RATE_COLUMN_SCALE}::int)),
         ${c.to}, greatest(p."effectiveFrom", now()), true, ${c.actor}::uuid, now()
    FROM tenant.tenant_package_meter_rate p
   WHERE p."currencyCode" = ${c.from} AND p."isActive"
     AND (p."effectiveFrom" > now() OR p."effectiveFrom" = (
           SELECT max(q."effectiveFrom") FROM tenant.tenant_package_meter_rate q
            WHERE q."packageId" = p."packageId" AND q."meterKey" = p."meterKey" AND q."currencyCode" = ${c.from}
              AND q."isActive" AND q."effectiveFrom" <= now()))`;

/**
 * A reseller's open Grant keeps its locked wholesale rate (F-118-n2), and it is
 * paid from the reseller's billing wallet, which converts with the platform:
 * the same price in the new money, the one change `grant_meter_terms_are_locked`
 * allows the wholesale leg. Every tenant's rows — this is the platform's change.
 */
export const convertWholesaleMeters = (c: Conversion) => c.tx.$executeRaw`
  UPDATE entitlement.grant_meter m
     SET "wholesaleUnitPrice" = greatest(round(m."wholesaleUnitPrice" * ${c.rate}::numeric, ${RATE_COLUMN_SCALE}::int),
                                         power(10::numeric, -${RATE_COLUMN_SCALE}::int)),
         "wholesaleCurrencyCode" = ${c.to}, "updatedAt" = now()
    FROM entitlement."grant" g
   WHERE g.id = m."grantId" AND m."wholesaleCurrencyCode" = ${c.from}
     AND g.status IN ('pending', 'active', 'suspended', 'exhausted')`;

/** Usage not yet billed to a reseller keeps its price, in the new money. */
export const convertUsageMeters = (c: Conversion) => c.tx.$executeRaw`
  UPDATE tenant.tenant_usage_meter
     SET "unitPrice" = round("unitPrice" * ${c.rate}::numeric, ${RATE_COLUMN_SCALE}::int), "currencyCode" = ${c.to}
   WHERE "currencyCode" = ${c.from} AND NOT "isBilled"`;

/**
 * A quota's overage price (F-019-v1, ADR-0107 point 2) is paid from the
 * reseller's billing wallet, so it is in the platform's money and converts
 * with it, at every level and where a period locked it (F-019-v3) — and so does the reseller's cap on it. Never to nothing: a price the column rounds to zero
 * is one minor unit — a free overage is a decision, not a rounding.
 */
export async function convertQuotaOverages(c: Conversion): Promise<number> {
  const price = Prisma.sql`greatest(round("unitPrice" * ${c.rate}::numeric, ${c.dp}::int), power(10::numeric, -${c.dp}::int))`;
  const platform = await c.tx.$executeRaw`
    UPDATE tenant.quota_overage_setting SET "unitPrice" = ${price}, "currencyCode" = ${c.to}, "updatedAt" = now() WHERE "currencyCode" = ${c.from}`;
  const packages = await c.tx.$executeRaw`
    UPDATE tenant.package_quota_overage SET "unitPrice" = ${price}, "currencyCode" = ${c.to}, "updatedAt" = now() WHERE "currencyCode" = ${c.from}`;
  // A product's overage on a package (F-019-v6) is the same kind of price.
  const products = await c.tx.$executeRaw`
    UPDATE tenant.package_product SET "unitPrice" = ${price}, "currencyCode" = ${c.to}, "updatedAt" = now() WHERE "currencyCode" = ${c.from}`;
  const resellers = await c.tx.$executeRaw`
    UPDATE tenant.reseller_quota_overage SET "unitPrice" = ${price}, "currencyCode" = ${c.to}, "updatedAt" = now() WHERE "currencyCode" = ${c.from}`;
  // A price frozen for a reseller's paid period (F-019-v3) is the same price, so it converts the same way.
  const locked = await c.tx.$executeRaw`
    UPDATE tenant.reseller_quota_terms_lock SET "unitPrice" = ${price}, "currencyCode" = ${c.to} WHERE "currencyCode" = ${c.from}`;
  // A reseller's own ceiling on overage (F-019-v2): plain rounding — a cap of 0 stays "no overage at all".
  const caps = await c.tx.$executeRaw`
    UPDATE tenant.reseller_overage_cap SET amount = ${money(c, Prisma.sql`amount`)}, "currencyCode" = ${c.to}, "updatedAt" = now() WHERE "currencyCode" = ${c.from}`;
  return platform + packages + products + resellers + locked + caps;
}
