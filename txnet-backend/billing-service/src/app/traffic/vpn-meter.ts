import { Prisma } from '@prisma/client';
import { METER_KEYS } from '@txnet-backend/shared-core';

/**
 * A metered VPN Grant's `vpn.traffic` meter (F-118-l, ADR-0105 (12)): its
 * rate (`unitPrice` per 2^30 bytes, `grant_meter_vpn_traffic_is_per_gib`),
 * the currency it is debited in, its mode and its money cursor `billed` —
 * what `grant.meteredRate` and `grant.billedBytes` were. The bag stays
 * `grant.purchasedBytes` and the measure `grant.consumedBytes`, every Grant's.
 *
 * Null is not a metered VPN Grant: a package plan has no meter (decision 0).
 */
export function vpnMeterOf(tx: Prisma.TransactionClient, grantId: string) {
  return tx.grantMeter.findUnique({ where: { grantId_meterKey: { grantId, meterKey: METER_KEYS.vpnTraffic } } });
}

/** A Grant that has a `vpn.traffic` meter, for a `where`. */
export const HAS_VPN_METER = { meters: { some: { meterKey: METER_KEYS.vpnTraffic } } } satisfies Prisma.GrantWhereInput;

/** Its `vpn.traffic` meter's price and currency, for a `select`: at most one row. */
export const VPN_RATE_SELECT = {
  meters: { where: { meterKey: METER_KEYS.vpnTraffic }, select: { unitPrice: true, currencyCode: true } },
} satisfies Prisma.GrantSelect;
