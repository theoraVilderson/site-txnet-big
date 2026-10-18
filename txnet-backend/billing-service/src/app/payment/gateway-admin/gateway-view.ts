import { PaymentProviderName, Prisma } from '@prisma/client';
import { moneyText } from '@txnet-backend/shared-core';

import type { GatewaySource } from '../gateway/gateway-merchant';
import { PROVIDER_FIELDS, type GatewaySecretName } from '../gateway/provider-fields';
import { type ManualSettingRow, type ManualSettingView, manualSettingView } from '../manual/manual-setting';
import type { GatewaySecretsState } from './gateway-admin.service';

/** What gateway management answers for one gateway (F-102-c), built from its row. */

type Row = Record<string, unknown>;

export type GatewayView = {
  source: GatewaySource;
  id: string;
  /** The owning tenant; `null` for a platform gateway, which is the platform owner's by definition. */
  tenantId: string | null;
  displayName: string;
  providerName: string;
  gatewayCategory: string;
  isActive: boolean;
  /** The platform owner's block (F-104-ak); `null` when not blocked, and always for a platform gateway. */
  blocked: { at: Date; reason: string } | null;
  description: string | null;
  supportedCurrencies: unknown;
  confirmationMode: string | null;
  /**
   * What its limits, fixed fee, fixed modifier and presets are in: the
   * gateway's own, its owner's at the time (ADR-0098 part 3, F-116-h2).
   */
  currencyCode: string;
  minAcceptAmount: string | null;
  maxAcceptAmount: string | null;
  feeCalculationMode: string;
  feeType: string;
  feeValue: string;
  feeFloor: string | null;
  feeCeiling: string | null;
  useLiveRate: boolean;
  staticRate: string | null;
  percentageModifier: string | null;
  fixedAmountModifier: string | null;
  minRate: string | null;
  maxRate: string | null;
  roundingStep: string | null;
  roundingMode: string | null;
  /** This gateway's own quick amounts; empty means it inherits the tenant's default (F-092-v). */
  depositPresets: string[];
  /** This gateway's own tax rate; `null` means it inherits the tenant's default (ADR-0076). */
  taxRatePercent: string | null;
  /** The callback address sent to the provider, or `null` for the tenant's panel domain (F-092-w). */
  callbackUrl: string | null;
  /** A manual gateway's kind, mode, proof, window and destination counts (F-803-c); `null` for any other. */
  manual: ManualSettingView | null;
  /** The owner's user groups it is offered to; empty = everyone (F-102-g). */
  userGroupIds: string[];
  /** `null` when the vault writer could not be asked; the list still renders. */
  credentials: GatewaySecretsState | null;
  /**
   * The secrets this gateway's provider needs that are not stored — the
   * heads-up for a gateway that is saved, maybe active, and cannot take a
   * payment yet (F-104-e). `null` when `credentials` is.
   */
  missingSecrets: GatewaySecretName[] | null;
  createdAt: Date;
  updatedAt: Date;
};

/** A nullable column as a string — decimals keep their scale (C-02). */
export const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
/** Quick amounts as stored, at 2 places (F-092-v). */
export const presetStrings = (v: unknown): string[] => (Array.isArray(v) ? v.map((d) => moneyText(new Prisma.Decimal(String(d)))) : []);

/**
 * A gateway row as every answer shows it. Secrets never: only their state
 * and what is missing (F-104-e). `row.manualSetting` is read when the caller
 * selected it (`MANUAL_SETTING_SELECT`).
 */
export function gatewayView(source: GatewaySource, row: Row, credentials: GatewaySecretsState | null, userGroupIds: string[] = []): GatewayView {
  return {
    source,
    id: row['id'] as string,
    tenantId: source === 'tenant' ? (row['tenantId'] as string) : null,
    displayName: row['displayName'] as string,
    providerName: row['providerName'] as string,
    gatewayCategory: row['gatewayCategory'] as string,
    isActive: Boolean(row['isActive']),
    blocked:
      source === 'tenant' && row['blockedAt']
        ? { at: row['blockedAt'] as Date, reason: String(row['blockedReason'] ?? '') }
        : null,
    description: source === 'platform' ? str(row['description']) : null,
    supportedCurrencies: source === 'platform' ? (row['supportedCurrencies'] ?? []) : null,
    confirmationMode: source === 'platform' ? str(row['confirmationMode']) : null,
    currencyCode: row['currencyCode'] as string,
    minAcceptAmount: str(row['minAcceptAmount']),
    maxAcceptAmount: str(row['maxAcceptAmount']),
    feeCalculationMode: row['feeCalculationMode'] as string,
    feeType: row['feeType'] as string,
    feeValue: String(row['feeValue']),
    feeFloor: str(row['feeFloor']),
    feeCeiling: str(row['feeCeiling']),
    useLiveRate: row['useLiveRate'] !== false,
    staticRate: str(row['staticRate']),
    percentageModifier: str(row['percentageModifier']),
    fixedAmountModifier: str(row['fixedAmountModifier']),
    minRate: str(row['minRate']),
    maxRate: str(row['maxRate']),
    roundingStep: str(row['roundingStep']),
    roundingMode: str(row['roundingMode']),
    depositPresets: presetStrings(row['depositPresets']),
    taxRatePercent: str(row['taxRatePercent']),
    callbackUrl: str(row['callbackUrl']),
    manual: manualSettingView(row['manualSetting'] as ManualSettingRow | null | undefined),
    userGroupIds,
    credentials,
    missingSecrets: credentials
      ? (PROVIDER_FIELDS[row['providerName'] as PaymentProviderName]?.secrets ?? []).filter((k) => !credentials[k].configured)
      : null,
    createdAt: row['createdAt'] as Date,
    updatedAt: row['updatedAt'] as Date,
  };
}
