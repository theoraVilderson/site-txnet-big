import { Prisma } from '@prisma/client';

import type { Day } from './analytics-days';
import { Amounts, FEWER_THAN, amountsOf, byCurrency, hiddenKeys } from './analytics-figures';

/**
 * The cohort grid (F-1004-a), pure so the spec holds it: a cohort is the
 * month of a user's first purchase; month k is the k-th month from it. Every
 * share and per-user figure is over the cohort's size, LTV is the running sum
 * of net per member, and money stays per currency (principle 6).
 */

/** Rows the reads answer, each by cohort month and signup source (the channel, ADR-0149 (5)). */
export type CohortInput = {
  /** The window's month keys, in order: index = month number. */
  months: Day[];
  sizes: { cohort: Day; source: string; users: number }[];
  /** Members with a sale or a refund in that month. */
  active: { cohort: Day; month: Day; source: string; users: number }[];
  net: { cohort: Day; month: Day; source: string; currencyCode: string; net: Prisma.Decimal }[];
};

/** A cohort's size, or one hidden from the platform's staff. */
export type CohortSize = { cohort: Day; users: number } | { cohort: Day; people: typeof FEWER_THAN };
/** One cohort's month k. Flat rows, so the export writes the grid as it writes any list. */
export type CohortCell = { cohort: Day; k: number; share: number; netPerUser: Amounts; ltv: Amounts };
export type ChannelSize = { source: string; users: number } | { source: string; people: typeof FEWER_THAN };
/** A channel's LTV at month k over every cohort old enough to have reached it; a k none has reached has no row. */
export type ChannelPoint = { source: string; k: number; ltv: Amounts };
export type CohortGrid = { cohorts: CohortSize[]; cells: CohortCell[]; channels: ChannelSize[]; channelLtv: ChannelPoint[] };

/** A share is answered to four places, as a delta is. */
const SHARE_PLACES = 4;
/** Money per member to the cent, as every amount. */
const MONEY_PLACES = 2;

const perUser = (sums: Map<string, Prisma.Decimal>, users: number) => new Map([...sums].map(([c, v]) => [c, v.div(users).toDecimalPlaces(MONEY_PLACES)]));

/** The grid and the channels' curves, the small cells hidden from the platform's staff (ADR-0104 (3)). */
export function cohortGridOf(input: CohortInput, how: { currencies: readonly string[]; hides: boolean }): CohortGrid {
  const index = new Map(input.months.map((m, i) => [m, i]));
  const kOf = (cohort: Day, month: Day) => (index.get(month) ?? 0) - (index.get(cohort) ?? 0);
  const last = input.months.length - 1;
  const cohortKeys = input.months.filter((m) => input.sizes.some((s) => s.cohort === m));
  const sizeOf = (pick: (s: CohortInput['sizes'][number]) => boolean) => input.sizes.filter(pick).reduce((n, s) => n + s.users, 0);

  const rows = cohortKeys.map((cohort) => {
    const users = sizeOf((s) => s.cohort === cohort);
    const net = input.net.filter((r) => r.cohort === cohort);
    const running = new Map<string, Prisma.Decimal>();
    const cells: Omit<CohortCell, 'cohort'>[] = [];
    for (let k = 0; k <= last - (index.get(cohort) ?? 0); k++) {
      const month = byCurrency(net.filter((r) => kOf(cohort, r.month) === k), (r) => r.net);
      for (const [c, v] of month) running.set(c, (running.get(c) ?? new Prisma.Decimal(0)).plus(v));
      const active = input.active.filter((r) => r.cohort === cohort && kOf(cohort, r.month) === k).reduce((n, r) => n + r.users, 0);
      cells.push({ k, share: new Prisma.Decimal(active).div(users).toDecimalPlaces(SHARE_PLACES).toNumber(), netPerUser: amountsOf(perUser(month, users), how.currencies), ltv: amountsOf(perUser(running, users), how.currencies) });
    }
    return { cohort, users, cells, currencies: new Set(net.map((r) => r.currencyCode)) };
  });

  const sources = [...new Set(input.sizes.map((s) => s.source))].sort();
  const channels = sources.map((source) => {
    const ltv = input.months.map((_, k) => {
      // Only the cohorts that have lived k months count towards month k.
      const old = cohortKeys.filter((c) => (index.get(c) ?? 0) + k <= last);
      const users = sizeOf((s) => s.source === source && old.includes(s.cohort));
      if (users === 0) return null;
      const sums = byCurrency(input.net.filter((r) => r.source === source && old.includes(r.cohort) && kOf(r.cohort, r.month) <= k), (r) => r.net);
      return amountsOf(perUser(sums, users), how.currencies);
    });
    return { source, users: sizeOf((s) => s.source === source), ltv, currencies: new Set(input.net.filter((r) => r.source === source).map((r) => r.currencyCode)) };
  });

  const hiddenCohorts = hiddenKeys(rows.map((r) => ({ key: r.cohort, people: r.users, count: r.users, currencies: r.currencies })), how.hides);
  const hiddenChannels = hiddenKeys(channels.map((r) => ({ key: r.source, people: r.users, count: r.users, currencies: r.currencies })), how.hides);
  const ordered = channels.sort((a, b) => b.users - a.users || a.source.localeCompare(b.source));
  return {
    cohorts: rows.map(({ cohort, users }) => (hiddenCohorts.has(cohort) ? { cohort, people: FEWER_THAN } : { cohort, users })),
    cells: rows.filter((r) => !hiddenCohorts.has(r.cohort)).flatMap((r) => r.cells.map((cell) => ({ cohort: r.cohort, ...cell }))),
    channels: ordered.map(({ source, users }) => (hiddenChannels.has(source) ? { source, people: FEWER_THAN } : { source, users })),
    channelLtv: ordered
      .filter((r) => !hiddenChannels.has(r.source))
      .flatMap((r) => r.ltv.flatMap((ltv, k) => (ltv ? [{ source: r.source, k, ltv }] : []))),
  };
}
