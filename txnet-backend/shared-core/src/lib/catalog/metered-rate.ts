/**
 * The unit a metered rate is quoted in (ADR-0073, F-027-g).
 *
 * `catalog.metered_rate.rate` is money per **2^30 bytes**. Bytes are the only
 * unit anything stores — a Grant's cursors, a panel's counters, a purchased
 * block — and "GB" is a rendering concern. The constant lives here so it is
 * spelled once: the same number in three files is wrong in one of them, and
 * the symptom is a bill off by a factor of 1024.
 *
 * A `number`, not a `bigint`: the spec tsconfigs target `es2015`, where a
 * `BigInt` literal will not compile. 2^30 is exact in a double, and the byte
 * counts it divides are `Prisma.Decimal` by the time any money is derived
 * from them (ADR-0072).
 */
export const METERED_RATE_UNIT_BYTES = 1024 * 1024 * 1024;
