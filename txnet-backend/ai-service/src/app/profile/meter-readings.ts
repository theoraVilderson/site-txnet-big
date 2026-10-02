const HOUR_MS = 3_600_000;

/** A Grant meter's counter as read this hour. */
export type MeterCounter = { userId: string; grantId: string; meterKey: string; counter: bigint };

export type MeterReadingRow = MeterCounter & { hour: Date; delta: bigint };

/** The start of `at`'s UTC hour — a reading's key. */
export function utcHour(at: Date): Date {
  return new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS);
}

/** The map key {@link readingsFor} looks a meter's last counter up by. */
export function meterRef(grantId: string, meterKey: string): string {
  return `${grantId}|${meterKey}`;
}

/**
 * This hour's `ai.meter_reading` rows (F-038-c). `last` is each meter's most
 * recent counter, keyed by {@link meterRef}.
 *
 * - No earlier reading: a baseline, `delta` 0 — growth before the engine first
 *   looked is not this hour's.
 * - The counter grew: one row with the growth.
 * - The counter did not move: nothing. An idle meter costs no row, which is
 *   what keeps 180 days of these affordable.
 * - The counter went **down** (a counter only grows, so this is a replaced
 *   meter or a restore): a new baseline, never a negative growth.
 */
export function readingsFor(counters: readonly MeterCounter[], last: ReadonlyMap<string, bigint>, hour: Date): MeterReadingRow[] {
  const rows: MeterReadingRow[] = [];
  for (const c of counters) {
    const before = last.get(meterRef(c.grantId, c.meterKey));
    if (before === undefined || c.counter < before) rows.push({ ...c, hour, delta: BigInt(0) });
    else if (c.counter > before) rows.push({ ...c, hour, delta: c.counter - before });
  }
  return rows;
}
