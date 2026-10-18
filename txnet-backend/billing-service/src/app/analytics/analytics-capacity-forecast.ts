import { Prisma } from '@prisma/client';
import { forecastSpanMs, roundConverted, type CurrencyPlaces } from '@txnet-backend/shared-core';

import { type CostRow, costOn } from '../systems/panel-cost-on';
import { Day, addDays } from './analytics-days';

/**
 * Capacity arithmetic (F-1005-a, contract.analytics-tabs.md "Capacity"), pure
 * so the spec holds it. A month is the **UTC month**, as a panel's price and
 * its traffic days are. The rate is ai's one forecast rule (`forecastSpanMs`,
 * F-1525-a): the last 7 complete days, a younger history over itself, none
 * under a day. Today is never in the rate — its traffic lands a pass later.
 */

const DAY_MS = 86_400_000;
/** A users' cap further out than this is no date: growth this slow says nothing a month's planning can use. */
export const CLIENTS_HORIZON_DAYS = 90;
/** A users' growth is answered to two places. */
const RATE_PLACES = 2;

export type CapacityInput = {
  /** The UTC day the forecast is made on. */
  today: Day;
  /** The panel's traffic per UTC day, every tenant's users, the days before today. */
  traffic: { day: Day; bytes: bigint }[];
  firstTrafficDay: Day | null;
  /** The month's traffic allowance of the price in effect today; null = none set. */
  allowanceBytes: bigint | null;
  /** Grants with a live config on the panel at each day's last pass. */
  clients: { day: Day; clients: number }[];
  maxClients: number | null;
};

export type PanelForecast = {
  usedBytes: string;
  perDayBytes: string | null;
  projectedBytes: string | null;
  allowanceBytes: string | null;
  trafficFullOn: Day | null;
  /** How many days the rate was read over (1–7); null under one. */
  observedDays: number | null;
  clients: number | null;
  maxClients: number | null;
  clientsPerDay: number | null;
  clientsFullOn: Day | null;
  /** The sooner of the two; `daysUntilFull` 0 is today. */
  fullOn: Day | null;
  daysUntilFull: number | null;
};

const ms = (day: Day) => Date.parse(`${day}T00:00:00Z`);
const daysBetween = (from: Day, to: Day) => Math.round((ms(to) - ms(from)) / DAY_MS);
const monthStartOf = (day: Day) => `${day.slice(0, 8)}01`;
/** The last day of `day`'s month. */
export const monthEndOf = (day: Day): Day => new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)), 0)).toISOString().slice(0, 10);

/** Whole days the rate is read over before `today`, from the first observation; null under one. */
function rateDays(first: Day | null, today: Day): number | null {
  if (first === null) return null;
  const span = forecastSpanMs(ms(first), ms(today));
  return span === null ? null : Math.floor(span / DAY_MS);
}

/** Days from today to the month's end, today included: what is still to be used. */
const daysLeft = (today: Day) => daysBetween(today, monthEndOf(today)) + 1;

function trafficOf(i: CapacityInput) {
  const monthStart = monthStartOf(i.today);
  const used = i.traffic.filter((t) => t.day >= monthStart && t.day < i.today).reduce((n, t) => n + t.bytes, BigInt(0));
  const span = rateDays(i.firstTrafficDay, i.today);
  const since = span === null ? null : addDays(i.today, -span);
  const perDay = since === null || span === null ? null : i.traffic.filter((t) => t.day >= since && t.day < i.today).reduce((n, t) => n + t.bytes, BigInt(0)) / BigInt(span);
  let fullOn: Day | null = null;
  if (i.allowanceBytes !== null && used >= i.allowanceBytes) fullOn = i.today;
  else if (i.allowanceBytes !== null && perDay !== null && perDay > BigInt(0)) {
    const need = i.allowanceBytes - used;
    // Today is the first day the rest is used on.
    const on = addDays(i.today, Number((need + perDay - BigInt(1)) / perDay) - 1);
    fullOn = on <= monthEndOf(i.today) ? on : null;
  }
  return {
    usedBytes: used.toString(),
    perDayBytes: perDay?.toString() ?? null,
    projectedBytes: perDay === null ? null : (used + perDay * BigInt(daysLeft(i.today))).toString(),
    allowanceBytes: i.allowanceBytes?.toString() ?? null,
    trafficFullOn: fullOn,
    observedDays: span,
  };
}

function clientsOf(i: CapacityInput) {
  const sorted = [...i.clients].filter((c) => c.day <= i.today).sort((a, b) => a.day.localeCompare(b.day));
  const latest = sorted[sorted.length - 1];
  if (!latest) return { clients: null, maxClients: i.maxClients, clientsPerDay: null, clientsFullOn: null };
  const earliest = sorted.find((c) => c.day >= addDays(latest.day, -7) && c.day < latest.day) ?? null;
  const span = earliest ? rateDays(earliest.day, latest.day) : null;
  const perDay = earliest && span ? (latest.clients - earliest.clients) / span : null;
  let fullOn: Day | null = null;
  if (i.maxClients !== null && latest.clients >= i.maxClients) fullOn = i.today;
  else if (i.maxClients !== null && perDay !== null && perDay > 0) {
    const days = Math.ceil((i.maxClients - latest.clients) / perDay);
    fullOn = days <= CLIENTS_HORIZON_DAYS ? addDays(i.today, days) : null;
  }
  return { clients: latest.clients, maxClients: i.maxClients, clientsPerDay: perDay === null ? null : Number(perDay.toFixed(RATE_PLACES)), clientsFullOn: fullOn };
}

/** One panel's month: its traffic against the allowance, its users against the cap, and the sooner full date. */
export function forecastPanel(i: CapacityInput): PanelForecast {
  const traffic = trafficOf(i);
  const clients = clientsOf(i);
  const dates = [traffic.trafficFullOn, clients.clientsFullOn].filter((d): d is Day => d !== null).sort();
  const fullOn = dates[0] ?? null;
  return { ...traffic, ...clients, fullOn, daysUntilFull: fullOn === null ? null : daysBetween(i.today, fullOn) };
}

/**
 * Money to the month's end, per currency and never across two (principle 6):
 * the month's days before today, plus the same 7-day rate for the days left,
 * rounded half up to each currency's places (ADR-0153). Null under a day of history.
 */
export function projectMonth(
  rows: readonly { day: Day; currencyCode: string; amount: Prisma.Decimal }[],
  at: { first: Day | null; today: Day; places: CurrencyPlaces },
): Map<string, Prisma.Decimal> | null {
  const { first, today } = at;
  const span = rateDays(first, today);
  if (span === null) return null;
  const since = addDays(today, -span);
  const monthStart = monthStartOf(today);
  const out = new Map<string, Prisma.Decimal>();
  for (const currency of new Set(rows.map((r) => r.currencyCode))) {
    const mine = rows.filter((r) => r.currencyCode === currency && r.day < today);
    const sum = (from: Day) => mine.filter((r) => r.day >= from).reduce((n, r) => n.plus(r.amount), new Prisma.Decimal(0));
    out.set(currency, roundConverted(sum(monthStart).plus(sum(since).div(span).times(daysLeft(today))), at.places.of(currency)));
  }
  return out;
}

/**
 * The month's whole cost in USD, each day at the price in effect on it
 * (`costOn`), rounded half up to USD's `places`; null when no day has one.
 */
export function monthCostUsd(history: readonly CostRow[], today: Day, places: number): Prisma.Decimal | null {
  const end = monthEndOf(today);
  const daysInMonth = Number(end.slice(8, 10));
  let total: Prisma.Decimal | null = null;
  for (let day = monthStartOf(today); day <= end; day = addDays(day, 1)) {
    const price = costOn(history, day);
    if (price) total = (total ?? new Prisma.Decimal(0)).plus(price.monthlyCostUsd.div(daysInMonth));
  }
  return total ? roundConverted(total, places) : null;
}
