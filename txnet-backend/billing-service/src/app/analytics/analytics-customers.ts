import { Prisma } from '@prisma/client';

import type { TabContext } from './analytics-context';
import type { Day } from './analytics-days';
import { Amounts, FEWER_THAN, amountsOf, byCurrency, currenciesOf, hiddenKeys } from './analytics-figures';
import { Window, bucketJoin, in_, productPanel, readBuyers } from './analytics-read';
import { renewalWindowOf } from './analytics-settings';

/** The Customers tab's list of people: this many, largest net first. */
const TOP_CUSTOMERS = 20;
/** A rate to four places, as every analytics rate is. */
const RATE_PLACES = 10_000;

/** Ended terms in a window and where they stand; `rate` leaves `pending` out (contract "Renewal"). */
export type RenewalFigures = { rate: number | null; renewed: number; lapsed: number; pending: number };

type Hidden<K extends string> = { [k in K]: string | null } & { people: typeof FEWER_THAN };

export type CustomersTab = {
  currencies: string[];
  /** The window renewal was judged by, 1..30 days (the tenant's `renewalWindowDays`). */
  renewalWindowDays: number;
  /** Buyers per bucket whose first purchase fell in it, and the rest. */
  buyers: { newBuyers: (number | null)[]; returningBuyers: (number | null)[] };
  signups: {
    total: number;
    purchased7: { count: number; rate: number | null };
    purchased30: { count: number; rate: number | null };
    series: (number | null)[];
    bySource: ({ source: string; signups: number } | Hidden<'source'>)[];
  };
  renewal: RenewalFigures;
  renewalByProduct: (({ productId: string | null } & RenewalFigures) | Hidden<'productId'>)[];
  /** A reseller's own people, to itself; `null` to the platform's staff, who never see a person (ADR-0104). */
  topCustomers: { userId: string; name: string | null; net: Amounts; orders: number }[] | null;
};

/**
 * A count's cells share one whole, and that whole is answered — so to the
 * complement rule (ADR-0104 (3)) they are cells of one "currency": a lone
 * hidden cell would be the whole minus the shown ones.
 */
const ONE_WHOLE: ReadonlySet<string> = new Set(['count']);

const rateOf = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * RATE_PLACES) / RATE_PLACES : null);

export function renewalOf(c: { renewed: number; lapsed: number; pending: number }): RenewalFigures {
  return { rate: rateOf(c.renewed, c.renewed + c.lapsed), renewed: c.renewed, lapsed: c.lapsed, pending: c.pending };
}

type RenewalRow = { productId: string | null; renewed: number; lapsed: number; pending: number; users: number };

/** Terms that ended in `w`, by state, and the people they belong to — per product when asked. */
function readRenewal(c: TabContext, w: Window, byProduct: boolean): Promise<RenewalRow[]> {
  const g = Prisma.sql`g`;
  return c.tx.$queryRaw<RenewalRow[]>`
    SELECT ${byProduct ? Prisma.sql`g."productId" AS "productId"` : Prisma.sql`NULL AS "productId"`},
           (COUNT(*) FILTER (WHERE g."state" = 'renewed'))::int AS "renewed",
           (COUNT(*) FILTER (WHERE g."state" = 'lapsed'))::int AS "lapsed",
           (COUNT(*) FILTER (WHERE g."state" = 'pending'))::int AS "pending",
           COUNT(DISTINCT g."userId")::int AS "users"
    FROM billing.analytics_grant_end g
    WHERE g."tenantId" = public.current_tenant_id() AND g."endedOn" BETWEEN ${w.from}::date AND ${w.to}::date ${productPanel(g, c.filters)}
    ${byProduct ? Prisma.sql`GROUP BY g."productId"` : Prisma.empty}`;
}

/** The whole window's renewal — the Overview's KPI and this tab's headline. */
export async function renewalFiguresOf(c: TabContext): Promise<RenewalFigures> {
  const [row] = await readRenewal(c, c.window, false);
  return renewalOf(row ?? { renewed: 0, lapsed: 0, pending: 0 });
}

async function renewalByProductOf(c: TabContext): Promise<CustomersTab['renewalByProduct']> {
  const rows = (await readRenewal(c, c.window, true)).sort((a, b) => b.users - a.users || String(a.productId).localeCompare(String(b.productId)));
  const hidden = hiddenKeys(rows.map((r) => ({ key: r.productId, people: r.users, count: r.renewed + r.lapsed + r.pending, currencies: ONE_WHOLE })), c.hides);
  return [
    ...rows.filter((r) => !hidden.has(r.productId)).map((r) => ({ productId: r.productId, ...renewalOf(r) })),
    ...[...hidden].sort().map((productId) => ({ productId, people: FEWER_THAN })),
  ];
}

type SignupRow = { bucket: string | null; source: string | null; signups: number; purchased7: number; purchased30: number };

/** Signups in the window — by bucket when cut by the window's map, else by source. A signup names no product: unfiltered. */
function readSignups(c: TabContext, split: 'bucket' | 'source'): Promise<SignupRow[]> {
  const n = Prisma.sql`n`;
  const bySource = split === 'source';
  return c.tx.$queryRaw<SignupRow[]>`
    SELECT ${bySource ? Prisma.sql`NULL AS "bucket", n."source"` : Prisma.sql`to_char(m."bucket", 'YYYY-MM-DD') AS "bucket", NULL AS "source"`},
           SUM(n."signups")::int AS "signups", SUM(n."purchased7")::int AS "purchased7", SUM(n."purchased30")::int AS "purchased30"
    FROM billing.analytics_signup_day n ${bySource ? Prisma.empty : bucketJoin(n, c.map)}
    WHERE ${in_(n, c.window)}
    GROUP BY ${bySource ? Prisma.sql`n."source"` : Prisma.sql`m."bucket"`}`;
}

async function signupsOf(c: TabContext): Promise<CustomersTab['signups']> {
  const sources = (await readSignups(c, 'source')).sort((a, b) => b.signups - a.signups || String(a.source).localeCompare(String(b.source)));
  const buckets = new Map((await readSignups(c, 'bucket')).map((r) => [r.bucket ?? '', r.signups]));
  const sum = (k: 'signups' | 'purchased7' | 'purchased30') => sources.reduce((n, r) => n + r[k], 0);
  const total = sum('signups');
  const cell = (key: string, people: number) => ({ key, people, count: people, currencies: ONE_WHOLE });
  const hiddenSources = hiddenKeys(sources.map((r) => cell(r.source ?? '', r.signups)), c.hides);
  const hiddenBuckets = hiddenKeys([...buckets].map(([key, people]) => cell(key, people)), c.hides);
  return {
    total,
    purchased7: { count: sum('purchased7'), rate: rateOf(sum('purchased7'), total) },
    purchased30: { count: sum('purchased30'), rate: rateOf(sum('purchased30'), total) },
    series: c.buckets.map((key: Day) => (hiddenBuckets.has(key) ? null : (buckets.get(key) ?? 0))),
    bySource: [
      ...sources.filter((r) => !hiddenSources.has(r.source ?? '')).map((r) => ({ source: r.source ?? '', signups: r.signups })),
      ...[...hiddenSources].sort().map((source) => ({ source, people: FEWER_THAN })),
    ],
  };
}

/** New and returning buyers per bucket; a bucket under 5 buyers is hidden from the platform's staff. */
async function buyersOf(c: TabContext): Promise<CustomersTab['buyers']> {
  const rows = new Map((await readBuyers(c.tx, c.window, c.filters, ['bucket'], c.map)).map((r) => [r.bucket ?? '', r]));
  const hidden = hiddenKeys([...rows].map(([key, r]) => ({ key, people: r.buyers, count: r.buyers, currencies: ONE_WHOLE })), c.hides);
  const each = (pick: (r: { buyers: number; newBuyers: number }) => number) => c.buckets.map((key) => (hidden.has(key) ? null : pick(rows.get(key) ?? { buyers: 0, newBuyers: 0 })));
  return { newBuyers: each((r) => r.newBuyers), returningBuyers: each((r) => r.buyers - r.newBuyers) };
}

type CustomerRow = { userId: string; currencyCode: string; net: Prisma.Decimal; orders: number };

/** The tenant's top customers by net in the operating currency, with their figures in every currency. */
async function topCustomersOf(c: TabContext): Promise<{ rows: CustomerRow[]; currencies: Set<string> }> {
  const u = Prisma.sql`u`;
  const rows = await c.tx.$queryRaw<CustomerRow[]>`
    WITH top AS (
      SELECT u."userId" FROM billing.analytics_user_day u
      WHERE ${in_(u, c.window)} ${productPanel(u, c.filters)} AND u."currencyCode" = ${c.operating}
      GROUP BY u."userId" HAVING SUM(u."net") > 0
      ORDER BY SUM(u."net") DESC, u."userId" LIMIT ${TOP_CUSTOMERS}
    )
    SELECT u."userId", u."currencyCode", SUM(u."net") AS "net", SUM(u."orders")::int AS "orders"
    FROM billing.analytics_user_day u JOIN top t ON t."userId" = u."userId"
    WHERE ${in_(u, c.window)} ${productPanel(u, c.filters)}
    GROUP BY u."userId", u."currencyCode"`;
  return { rows, currencies: new Set(rows.map((r) => r.currencyCode)) };
}

/** Each listed customer named — a label, not a figure, so it is read where it lives. */
async function namedCustomers(c: TabContext, rows: CustomerRow[], currencies: readonly string[]): Promise<NonNullable<CustomersTab['topCustomers']>> {
  const ids = [...new Set(rows.map((r) => r.userId))];
  const people = ids.length ? await c.tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true, username: true } }) : [];
  const names = new Map(people.map((p) => [p.id, p.fullName ?? p.username ?? null]));
  const zero = new Prisma.Decimal(0);
  return ids
    .map((userId) => {
      const own = rows.filter((r) => r.userId === userId);
      return { userId, name: names.get(userId) ?? null, sums: byCurrency(own, (r) => r.net), orders: own.reduce((n, r) => n + r.orders, 0) };
    })
    .sort((a, b) => (b.sums.get(c.operating) ?? zero).comparedTo(a.sums.get(c.operating) ?? zero) || a.userId.localeCompare(b.userId))
    .map((r) => ({ userId: r.userId, name: r.name, net: amountsOf(r.sums, currencies), orders: r.orders }));
}

export async function customersOf(c: TabContext): Promise<CustomersTab> {
  const top = c.hides ? null : await topCustomersOf(c);
  const currencies = currenciesOf(c.operating, top?.currencies ?? []);
  return {
    currencies,
    renewalWindowDays: await renewalWindowOf(c.tx),
    buyers: await buyersOf(c),
    signups: await signupsOf(c),
    renewal: await renewalFiguresOf(c),
    renewalByProduct: await renewalByProductOf(c),
    topCustomers: top ? await namedCustomers(c, top.rows, currencies) : null,
  };
}
