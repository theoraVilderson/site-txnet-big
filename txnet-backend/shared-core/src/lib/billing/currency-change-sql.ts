import { Prisma } from '@prisma/client';

/**
 * The SQL fragments a tenant's currency change (F-116-f, ADR-0098 part 5) is
 * written with, shared by the tenant's own converters (`currency-change.ts`)
 * and the platform's (`currency-change-platform.ts`). Every amount is rounded
 * once, here, to the new currency's decimals (ADR-0153).
 */

/** A metered rate is `DECIMAL(18,8)`. */
export const RATE_COLUMN_SCALE = 8;

export type Conversion = {
  tx: Prisma.TransactionClient;
  tenantId: string;
  changeId: string;
  from: string;
  to: string;
  /** Old -> new, as text, cast to `numeric` in SQL so no float is involved (C-02). */
  rate: string;
  /** The new currency's decimals: every amount is rounded to them once. */
  dp: number;
  platform: boolean;
  actor: string;
};

/** Rows owned by the tenant; for the platform, also the platform-wide ones (`tenantId` null). */
export const owned = (c: Conversion, column: Prisma.Sql) =>
  c.platform
    ? Prisma.sql`(${column} = ${c.tenantId}::uuid OR ${column} IS NULL)`
    : Prisma.sql`${column} = ${c.tenantId}::uuid`;

/** An amount column, converted and rounded to the new currency's decimals. */
export const money = (c: Conversion, column: Prisma.Sql) => Prisma.sql`round(${column} * ${c.rate}::numeric, ${c.dp}::int)`;

/**
 * A balance, converted: as {@link money}, but a positive one never to nothing —
 * under half a minor unit it is one (ADR-0153). Rounded to zero, its closing
 * row had no opening row, and the owner's money left the books unrecorded;
 * the unit costs the platform at most half of one, once per wallet.
 */
export const balance = (c: Conversion, column: Prisma.Sql) =>
  Prisma.sql`CASE WHEN ${column} > 0 THEN greatest(${money(c, column)}, power(10::numeric, -${c.dp}::int)) ELSE ${money(c, column)} END`;

/** A list of amounts, each converted, in its order. */
export const moneyList = (c: Conversion, column: Prisma.Sql) =>
  Prisma.sql`ARRAY(SELECT round(x * ${c.rate}::numeric, ${c.dp}::int) FROM unnest(${column}) WITH ORDINALITY AS t(x, i) ORDER BY i)`;
