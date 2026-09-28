import {
  ConfirmationMode,
  FeeCalcMode,
  FeeType,
  GatewayCategory,
  PaymentProviderName,
  RateRoundingMode,
  TenantGatewayVerificationStatus,
} from '@prisma/client';
import { GATEWAY_CREDENTIAL_SOURCES } from '@txnet-backend/shared-core';
import { z } from 'zod';

/**
 * The wire shapes of gateway management (F-102-c).
 *
 * **`.strict()` on both bodies.** An unknown key is refused, not dropped: the
 * two deprecated secret columns (`merchantIdEncrypted`, `apiKeyEncrypted`) and
 * `tenantId` on an update are exactly the keys a client might send expecting
 * them to land, and silently ignoring one is a secret the operator believes is
 * stored somewhere it is not.
 *
 * Decimals are strings (C-02). The three secrets are bounded strings and nothing
 * else — never echoed, never logged, relayed once to `auth-service` (F-102-a).
 */

/**
 * A decimal string, at its **column's** scale (F-104-ad).
 *
 * `numeric(18, 2)` does not refuse a third decimal place, it rounds it away —
 * so a `feeCeiling` of `0.125` was accepted here, stored as `0.13`, and the
 * operator was never told. Each field below names the scale of the column it
 * lands in; anything finer is refused, as a rate outside its range is
 * (`gateway-pricing.ts`), because money nobody asked for is not ours to round.
 */
const decimalAt = (places: number) => new RegExp(`^(0|[1-9]\\d{0,15})(\\.\\d{1,${places}})?$`);
const decimal = (what: string, places: number) => {
  const message = `${what} must be a decimal string with at most ${places} places`;
  return z.string({ message }).regex(decimalAt(places), { message });
};
/**
 * A gateway rate, `numeric(30, 18)`: 12 whole digits, 18 places. A currency
 * change divides these (F-116-f), so an inverse pair lands near 1e-6 and the
 * editor must be able to save back what it read.
 */
const rateAt = (signed: boolean) => new RegExp(`^${signed ? '-?' : ''}(0|[1-9]\\d{0,11})(\\.\\d{1,18})?$`);
const rate = (what: string, signed = false) => {
  const message = `${what} must be a decimal string with at most 18 places`;
  return z.string({ message }).regex(rateAt(signed), { message });
};
const uuid = (what: string) => z.string({ message: `${what} must be a uuid` }).uuid({ message: `${what} must be a uuid` });
const secret = (what: string) => z.string({ message: `${what} must be a string` }).min(1, { message: `${what} must not be empty` }).max(512);

const fields = {
  displayName: z.string().trim().min(1).max(100),
  providerName: z.nativeEnum(PaymentProviderName),
  gatewayCategory: z.nativeEnum(GatewayCategory),
  isActive: z.boolean(),
  // Either bound may be null: no limit on that side.
  minAcceptAmount: decimal('minAcceptAmount', 2).nullable(),
  maxAcceptAmount: decimal('maxAcceptAmount', 2).nullable(),
  feeCalculationMode: z.nativeEnum(FeeCalcMode),
  feeType: z.nativeEnum(FeeType),
  feeValue: decimal('feeValue', 4),
  feeFloor: decimal('feeFloor', 2).nullable(),
  feeCeiling: decimal('feeCeiling', 2).nullable(),
  useLiveRate: z.boolean(),
  staticRate: rate('staticRate').nullable(),
  // A modifier may be a markdown, so it takes a sign.
  percentageModifier: z.string().regex(/^-?(0|[1-9]\d{0,4})(\.\d{1,4})?$/, { message: 'percentageModifier must be a decimal string' }),
  fixedAmountModifier: rate('fixedAmountModifier', true),
  minRate: rate('minRate').nullable(),
  maxRate: rate('maxRate').nullable(),
  roundingStep: decimal('roundingStep', 8).nullable(),
  roundingMode: z.nativeEnum(RateRoundingMode),
  description: z.string().trim().max(500).nullable(),
  supportedCurrencies: z.array(z.string().regex(/^[A-Z0-9]{2,10}$/)).max(20),
  confirmationMode: z.nativeEnum(ConfirmationMode),
  verificationStatus: z.nativeEnum(TenantGatewayVerificationStatus),
  // Normalised and bounded by `deposit-presets.ts`; the schema only keeps the shape sane.
  depositPresets: z.array(z.string().max(20)).max(20),
  // Tax on a top-up (ADR-0076): `numeric(9, 4)`, 0..100 checked in the service; null inherits the tenant's default.
  taxRatePercent: decimal('taxRatePercent', 4).nullable(),
  // Checked by `callbackAddress` in the service; the schema only bounds it.
  callbackUrl: z.string().max(600).nullable(),
  merchantId: secret('merchantId'),
  secretKey: secret('secretKey'),
  webhookSecret: secret('webhookSecret'),
};

const optional = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.optional()])) as {
  [K in keyof typeof fields]: z.ZodOptional<(typeof fields)[K]>;
};

export const createGatewaySchema = z
  .object({
    source: z.enum(GATEWAY_CREDENTIAL_SOURCES),
    /** Whose gateway, for a tenant row. Absent is the caller's own tenant; another is the platform owner's alone. */
    tenantId: uuid('tenantId').optional(),
    ...optional,
  })
  .strict();

/**
 * Create, on the surface that names the reseller in its path (F-066-w3): the
 * same body without `tenantId`. Left out rather than ignored, because
 * `.strict()` then refuses it — a client that sent one meant to configure a
 * tenant, and the path is the only place this surface reads one from.
 */
export const createResellerGatewaySchema = z
  .object({ source: z.enum(GATEWAY_CREDENTIAL_SOURCES), ...optional })
  .strict();

export const updateGatewaySchema = z.object(optional).strict();

export const depositPresetsSchema = z.object({ presets: z.array(z.string().max(20)).max(20) }).strict();
export type DepositPresetsBody = z.infer<typeof depositPresetsSchema>;

/** The tenant's default tax on a top-up (F-104-ag). Required, so an empty body is not read as "clear it"; `null` is. */
export const depositTaxSchema = z.object({ taxRatePercent: fields.taxRatePercent }).strict();
export type DepositTaxBody = z.infer<typeof depositTaxSchema>;

export const listGatewaysSchema = z.object({ tenantId: uuid('tenantId').optional() });

export type CreateGatewayBody = z.infer<typeof createGatewaySchema>;
export type UpdateGatewayBody = z.infer<typeof updateGatewaySchema>;
export type ListGatewaysQuery = z.infer<typeof listGatewaysSchema>;
export type CreateResellerGatewayBody = z.infer<typeof createResellerGatewaySchema>;
