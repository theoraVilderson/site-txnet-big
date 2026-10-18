import { FeeType, Prisma } from '@prisma/client';
import { finerThanCurrency } from '@txnet-backend/shared-core';

import { GatewayAdminRefused } from './gateway-admin.refusal';

/**
 * A callback address as stored: trimmed, absolute, http or https — anything a
 * browser could be sent to that is not a web page (`javascript:`, `data:`) is
 * refused. Empty clears it. Which host it names is the operator's call: it is
 * the one their provider terminal is registered on.
 */
export function callbackAddress(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new GatewayAdminRefused('invalid_callback', 'not an absolute address');
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || trimmed.length > 500) {
    throw new GatewayAdminRefused('invalid_callback', 'only http(s), at most 500 characters');
  }
  return trimmed;
}

/** A decimal column's value as the service reads it: blank and absent are none. */
export const dec = (v: unknown): Prisma.Decimal | null => (v === null || v === undefined || v === '' ? null : new Prisma.Decimal(String(v)));

/**
 * A tax rate as stored (ADR-0076): a percentage, 0..100. The migration's CHECK
 * stands behind it, but a CHECK answers the operator's typo with a 500.
 */
export function taxRate(v: unknown): Prisma.Decimal | null {
  const d = dec(v);
  if (d && (d.isNegative() || d.greaterThan(100))) throw new GatewayAdminRefused('invalid_range', 'taxRatePercent must be 0..100');
  return d;
}

/**
 * A gateway's money — its accepted range, a fixed fee and its bounds, its quick
 * amounts — is in the gateway's currency and is refused finer than its places
 * (F-116-r): the schema takes what a column holds, and a rial bound of 1000.5
 * would otherwise refuse every payment that meets it. A percentage fee is a
 * ratio, not money, and keeps its own four places.
 */
export async function assertGatewayMoneyPlaces(tx: Pick<Prisma.TransactionClient, 'currency'>, currencyCode: string, gateway: Record<string, unknown>): Promise<void> {
  const presets = Array.isArray(gateway['depositPresets']) ? gateway['depositPresets'].map(dec).filter((d): d is Prisma.Decimal => d !== null) : null;
  const money = {
    minAcceptAmount: dec(gateway['minAcceptAmount']),
    maxAcceptAmount: dec(gateway['maxAcceptAmount']),
    feeFloor: dec(gateway['feeFloor']),
    feeCeiling: dec(gateway['feeCeiling']),
    feeValue: gateway['feeType'] === FeeType.fixed ? dec(gateway['feeValue']) : null,
    depositPresets: presets,
  };
  const finer = await finerThanCurrency(tx, currencyCode, money);
  if (finer) throw new GatewayAdminRefused(finer === 'depositPresets' ? 'invalid_presets' : 'invalid_range', `${finer} is finer than ${currencyCode}'s places`);
}
