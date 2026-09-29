import type { MeterUnit } from '@prisma/client';

/**
 * The meter registry's vocabulary in code (F-118-c, ADR-0105 decision 2).
 *
 * `catalog.meter` rows are written only by migrations, because a meter exists
 * only where code reports it. The code that reports or prices one names it
 * through `METER_KEYS`, so a key is spelled once — the same string in two
 * services is wrong in one of them, and the symptom is usage nobody bills.
 */
export const METER_KEYS = {
  /** VPN bytes, reported by network-service's traffic accounting. */
  vpnTraffic: 'vpn.traffic',
  /** One config regenerated on a VPN Grant, counted by billing-service, which runs it (F-118-q). Served through the per-use door (F-118-h). */
  configRegenerate: 'vpn.config.regenerate',
} as const;

export type MeterKey = (typeof METER_KEYS)[keyof typeof METER_KEYS];

/**
 * A meter's name key (F-118-s, D-59 (a)) — the seeded `catalog.meter.nameKey`.
 * Its text is committed in `locales/shareds/<lang>/catalog.json` with the code
 * that adds the meter, since no screen writes a meter's name.
 */
export const meterNameKey = (key: string): string => `catalog.meter.${key}.name`;

/**
 * Meters served through the per-use door (F-118-h, ADR-0105 decision 7):
 * each use is authorized before the work — refused when unfunded — and
 * committed after it (`billing-service` `usage/usage-door.ts`). A card on one
 * is sold on any variant; a meter in neither this set nor `vpn.traffic`'s
 * byte engine has nothing that refuses unfunded use, so it is not sold.
 */
export const DOOR_METERS: ReadonlySet<string> = new Set<string>([METER_KEYS.configRegenerate]);

/** Exhaustive over the Prisma enum: a unit added there fails to compile here (C-09). */
const UNITS: Record<MeterUnit, true> = { bytes: true, count: true, seconds: true, tokens: true };

/** What a meter counts; a rate card's `unitSize` is in it. */
export const METER_UNITS = Object.keys(UNITS) as readonly MeterUnit[];
