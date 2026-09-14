import {
  ConfirmationMode,
  FeeCalcMode,
  FeeType,
  GatewayCategory,
  PaymentProviderName,
  RateRoundingMode,
  TenantGatewayVerificationStatus,
} from '@prisma/client';
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
 * Decimals are strings (C-02). The two secrets are bounded strings and nothing
 * else — never echoed, never logged, relayed once to `auth-service` (F-102-a).
 */

const DECIMAL = /^(0|[1-9]\d{0,15})(\.\d{1,8})?$/;
const decimal = (what: string) => z.string({ message: `${what} must be a decimal string` }).regex(DECIMAL, { message: `${what} must be a decimal string` });
const uuid = (what: string) => z.string({ message: `${what} must be a uuid` }).uuid({ message: `${what} must be a uuid` });
const secret = (what: string) => z.string({ message: `${what} must be a string` }).min(1, { message: `${what} must not be empty` }).max(512);

const fields = {
  displayName: z.string().trim().min(1).max(100),
  providerName: z.nativeEnum(PaymentProviderName),
  gatewayCategory: z.nativeEnum(GatewayCategory),
  isActive: z.boolean(),
  minAcceptAmount: decimal('minAcceptAmount'),
  maxAcceptAmount: decimal('maxAcceptAmount'),
  feeCalculationMode: z.nativeEnum(FeeCalcMode),
  feeType: z.nativeEnum(FeeType),
  feeValue: decimal('feeValue'),
  feeFloor: decimal('feeFloor').nullable(),
  feeCeiling: decimal('feeCeiling').nullable(),
  useLiveRate: z.boolean(),
  staticRate: decimal('staticRate').nullable(),
  // A modifier may be a markdown, so it takes a sign.
  percentageModifier: z.string().regex(/^-?(0|[1-9]\d{0,4})(\.\d{1,4})?$/, { message: 'percentageModifier must be a decimal string' }),
  fixedAmountModifier: z.string().regex(/^-?(0|[1-9]\d{0,9})(\.\d{1,8})?$/, { message: 'fixedAmountModifier must be a decimal string' }),
  minRate: decimal('minRate').nullable(),
  maxRate: decimal('maxRate').nullable(),
  roundingStep: decimal('roundingStep').nullable(),
  roundingMode: z.nativeEnum(RateRoundingMode),
  description: z.string().trim().max(500).nullable(),
  supportedCurrencies: z.array(z.string().regex(/^[A-Z0-9]{2,10}$/)).max(20),
  confirmationMode: z.nativeEnum(ConfirmationMode),
  verificationStatus: z.nativeEnum(TenantGatewayVerificationStatus),
  // Normalised and bounded by `deposit-presets.ts`; the schema only keeps the shape sane.
  depositPresets: z.array(z.string().max(20)).max(20),
  // Checked by `callbackAddress` in the service; the schema only bounds it.
  callbackUrl: z.string().max(600).nullable(),
  merchantId: secret('merchantId'),
  secretKey: secret('secretKey'),
};

const optional = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.optional()])) as {
  [K in keyof typeof fields]: z.ZodOptional<(typeof fields)[K]>;
};

export const createGatewaySchema = z
  .object({
    source: z.enum(['platform', 'tenant']),
    /** Whose gateway, for a tenant row. Absent is the caller's own tenant; another is the platform owner's alone. */
    tenantId: uuid('tenantId').optional(),
    ...optional,
  })
  .strict();

export const updateGatewaySchema = z.object(optional).strict();

export const depositPresetsSchema = z.object({ presets: z.array(z.string().max(20)).max(20) }).strict();
export type DepositPresetsBody = z.infer<typeof depositPresetsSchema>;

export const listGatewaysSchema = z.object({ tenantId: uuid('tenantId').optional() });

export type CreateGatewayBody = z.infer<typeof createGatewaySchema>;
export type UpdateGatewayBody = z.infer<typeof updateGatewaySchema>;
export type ListGatewaysQuery = z.infer<typeof listGatewaysSchema>;
