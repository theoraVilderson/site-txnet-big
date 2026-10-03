import { Prisma } from '@prisma/client';

import type { Reason } from '../profile/predictions';

/**
 * F-038-i (ADR-0109 point 13): what a suggestion led to, and whether the
 * engine earns anything over saying nothing.
 *
 * **Outcome.** A suggestion is accepted when what it suggested happens within
 * {@link OUTCOME_WINDOW_DAYS} of it: a paid invoice for the plan it named
 * (`win_back` too, F-038-n), the user's own renewal of its Grant (`renew`
 * and `retain_offer`, F-038-f2, only), a gateway top-up
 * (`top_up_wallet`; `checkout_help` too, F-038-m). Measured from the decision (`createdAt`) to 7 days after
 * the send — or after the decision, for a row never sent.
 *
 * **Uplift.** Intent to treat: every row that reached the holdout step is
 * measured, the holdout's (`suppressedBy` `holdout`) as the control and every
 * other as treated — a row the budget, the margin or the schedule stopped
 * later is still a subject the engine would have spoken to. A row stopped
 * before the holdout (a prize, threshold, opt-out, cooldown, quiet-down, a switched-off
 * type) is in neither arm. One opportunity — subject, type, Grant and deadline
 * day — is one unit, however many daily rows it wrote.
 */

export const OUTCOME_WINDOW_DAYS = 7;
const WINDOW_MS = OUTCOME_WINDOW_DAYS * 86_400_000;

/** Steps that run before the holdout's, plus the two a subject or tenant sets later: such a row is in neither arm. */
export const UNMEASURED_STEPS: readonly string[] = ['prize', 'confidence_threshold', 'opt_out', 'cooldown', 'quiet_down', 'type_disabled'];
export const HOLDOUT_STEP = 'holdout';
/** A queued suggestion whose purchase already happened is stopped by this, never told after it. */
export const OUTCOME_REACHED = 'outcome_reached';
/** The types whose suggestion keeps a service running — the report's renewals. */
const RENEWING = new Set(['renew', 'retain_offer', 'resize_up', 'resize_down']);

export type OutcomeEvent = {
  kind: 'purchase' | 'renewal' | 'top_up';
  /** The invoice, renewal or wallet transaction. */
  ref: string;
  userId: string;
  at: Date;
  variantId: string | null;
  grantId: string | null;
  /** What was paid; null for a renewal, which records no price. */
  amount: string | null;
  currencyCode: string | null;
};

export type Outcome = { at: Date; ref: string; amount: string | null; currencyCode: string | null };

type Matchable = { actionType: string; subjectId: string; createdAt: Date; sentAt: Date | null; reasons: unknown };

function reason(reasons: unknown, code: string): Reason | null {
  return Array.isArray(reasons) ? ((reasons as Reason[]).find((r) => r?.code === code) ?? null) : null;
}
const str = (v: unknown) => (typeof v === 'string' ? v : null);

/** The earliest of the subject's events that is what `action` suggested, inside its window; else null. */
export function matchOutcome(action: Matchable, events: readonly OutcomeEvent[]): Outcome | null {
  const target = reason(action.reasons, 'suggest_variant');
  const variantId = str(target?.['variantId']);
  const grantId = str(target?.['grantId']);
  const fits = (e: OutcomeEvent): boolean => {
    switch (action.actionType) {
      case 'renew':
      case 'retain_offer':
        return (e.kind === 'purchase' && variantId !== null && e.variantId === variantId) || (e.kind === 'renewal' && grantId !== null && e.grantId === grantId);
      case 'resize_up':
      case 'resize_down':
      case 'win_back':
        return e.kind === 'purchase' && variantId !== null && e.variantId === variantId;
      case 'top_up_wallet':
      case 'checkout_help':
        return e.kind === 'top_up';
      default:
        return false;
    }
  };
  const from = action.createdAt.getTime();
  const to = (action.sentAt ?? action.createdAt).getTime() + WINDOW_MS;
  const hit = events
    .filter((e) => e.userId === action.subjectId && e.at.getTime() >= from && e.at.getTime() <= to && fits(e))
    .sort((a, b) => a.at.getTime() - b.at.getTime())[0];
  if (!hit) return null;
  // A renewal records no price: the one the suggestion named is what it was worth.
  const priced = hit.amount !== null && hit.currencyCode !== null;
  return {
    at: hit.at,
    ref: hit.ref,
    amount: priced ? hit.amount : str(target?.['price']),
    currencyCode: priced ? hit.currencyCode : str(target?.['currencyCode']),
  };
}

/** F-038-o5: what a reseller did, from its own billing ledger (`ai.reader_billing_event`). */
export type ResellerEvent = { kind: 'upgrade' | 'top_up'; ref: string; tenantId: string; at: Date; amount: string; currencyCode: string };

/**
 * A reseller's suggestion (F-038-o4, F-1525-c) converts on what it named, by
 * that reseller, between its decision and 7 days after its send: an upgrade on
 * an upgrade charge **while the reseller is now on the package named** (the
 * charge does not name it); a top-up on a billing-wallet top-up. The charge's
 * own amount is what it was worth (C-02).
 */
export function matchResellerOutcome(action: Matchable, events: readonly ResellerEvent[], currentPackageId: string | null): Outcome | null {
  const named = str(reason(action.reasons, 'suggest_package')?.['packageId']);
  const fits = (e: ResellerEvent): boolean => {
    if (action.actionType === 'resize_up') return e.kind === 'upgrade' && named !== null && currentPackageId === named;
    if (action.actionType === 'top_up_wallet') return e.kind === 'top_up';
    return false;
  };
  const from = action.createdAt.getTime();
  const to = (action.sentAt ?? action.createdAt).getTime() + WINDOW_MS;
  const hit = events
    .filter((e) => e.tenantId === action.subjectId && e.at.getTime() >= from && e.at.getTime() <= to && fits(e))
    .sort((a, b) => a.at.getTime() - b.at.getTime())[0];
  return hit ? { at: hit.at, ref: hit.ref, amount: hit.amount, currencyCode: hit.currencyCode } : null;
}

export function measured(row: { status: string; suppressedBy: string | null }): boolean {
  return row.status !== 'suppressed' || !UNMEASURED_STEPS.includes(row.suppressedBy ?? '');
}

/** The status change a conversion makes besides `convertedAt` and its amount; `outcomeAt` stays when a status ended (sent → accepted sets it). */
export function outcomeWrite(status: string): { status?: 'accepted' | 'suppressed'; suppressedBy?: string } {
  if (status === 'sent') return { status: 'accepted' };
  if (status === 'scheduled' || status === 'awaiting_approval') return { status: 'suppressed', suppressedBy: OUTCOME_REACHED };
  return {};
}

export type ReportRow = {
  subjectId: string;
  actionType: string;
  status: string;
  suppressedBy: string | null;
  createdAt: Date;
  deadline: Date | null;
  reasons: unknown;
  convertedAt: Date | null;
  convertedAmount: string | null;
  convertedCurrency: string | null;
};

export type Money = { amount: string; currencyCode: string };
export type Arm = { units: number; converted: number; rate: number | null; revenue: Money[]; margin: Money[]; marginUnknown: number };
export type TypeUplift = { actionType: string; treated: Arm; control: Arm; uplift: { rate: number | null; revenue: Money[]; margin: Money[] } };
export type UpliftReport = { from: string; to: string; types: TypeUplift[]; renewals: { treated: number; control: number } };

type Unit = { actionType: string; control: boolean; first: Date; outcome: ReportRow | null; cost: { amount: string; currencyCode: string } | null };
type Sums = Map<string, Prisma.Decimal>;

const rate = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 10_000) / 10_000);
const add = (sums: Sums, currency: string, amount: Prisma.Decimal) => sums.set(currency, (sums.get(currency) ?? new Prisma.Decimal(0)).plus(amount));
const money = (sums: Sums): Money[] =>
  [...sums.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currencyCode, amount]) => ({ amount: amount.toFixed(2), currencyCode }));

function arm(units: Unit[]): { arm: Arm; revenue: Sums; margin: Sums } {
  const revenue: Sums = new Map();
  const margin: Sums = new Map();
  let converted = 0;
  let marginUnknown = 0;
  for (const u of units) {
    const o = u.outcome;
    if (!o) continue;
    converted += 1;
    if (o.convertedAmount === null || o.convertedCurrency === null) {
      marginUnknown += 1;
      continue;
    }
    const paid = new Prisma.Decimal(o.convertedAmount);
    add(revenue, o.convertedCurrency, paid);
    if (u.cost && u.cost.currencyCode === o.convertedCurrency) add(margin, o.convertedCurrency, paid.minus(u.cost.amount));
    else marginUnknown += 1;
  }
  return {
    arm: { units: units.length, converted, rate: rate(converted, units.length), revenue: money(revenue), margin: money(margin), marginUnknown },
    revenue,
    margin,
  };
}

/** Per currency: (treated per unit − control per unit) × treated units — what the engine added over saying nothing. */
function lift(t: Sums, nt: number, c: Sums, nc: number): Money[] {
  if (nt === 0 || nc === 0) return [];
  const out: Sums = new Map();
  for (const currency of new Set([...t.keys(), ...c.keys()])) {
    const per = (s: Sums, n: number) => (s.get(currency) ?? new Prisma.Decimal(0)).dividedBy(n);
    out.set(currency, per(t, nt).minus(per(c, nc)).times(nt));
  }
  return money(out);
}

/** The uplift of each action type over the holdout, for units first decided in `[from, to)`. */
export function upliftReport(rows: readonly ReportRow[], period: { from: Date; to: Date }): UpliftReport {
  const units = new Map<string, Unit>();
  for (const r of rows) {
    if (!measured(r)) continue;
    const target = reason(r.reasons, 'suggest_variant');
    const day = r.deadline ? r.deadline.toISOString().slice(0, 10) : '';
    const key = [r.actionType, r.subjectId, str(target?.['grantId']) ?? '', day].join('|');
    const unit = units.get(key) ?? { actionType: r.actionType, control: false, first: r.createdAt, outcome: null, cost: null };
    if (r.suppressedBy === HOLDOUT_STEP) unit.control = true;
    if (r.createdAt < unit.first) unit.first = r.createdAt;
    if (r.convertedAt && (!unit.outcome || r.convertedAt < unit.outcome.convertedAt!)) unit.outcome = r;
    const m = reason(r.reasons, 'expected_margin');
    const cost = str(m?.['cost']);
    const currencyCode = str(m?.['currencyCode']);
    if (!unit.cost && m?.['costKnown'] === true && cost && currencyCode) unit.cost = { amount: cost, currencyCode };
    units.set(key, unit);
  }

  const byType = new Map<string, { treated: Unit[]; control: Unit[] }>();
  for (const u of units.values()) {
    if (u.first < period.from || u.first >= period.to) continue;
    const arms = byType.get(u.actionType) ?? { treated: [], control: [] };
    (u.control ? arms.control : arms.treated).push(u);
    byType.set(u.actionType, arms);
  }

  const renewals = { treated: 0, control: 0 };
  const types = [...byType.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([actionType, arms]): TypeUplift => {
      const t = arm(arms.treated);
      const c = arm(arms.control);
      if (RENEWING.has(actionType)) {
        renewals.treated += t.arm.converted;
        renewals.control += c.arm.converted;
      }
      const both = t.arm.rate !== null && c.arm.rate !== null;
      return {
        actionType,
        treated: t.arm,
        control: c.arm,
        uplift: {
          rate: both ? Math.round((t.arm.rate! - c.arm.rate!) * 10_000) / 10_000 : null,
          revenue: lift(t.revenue, t.arm.units, c.revenue, c.arm.units),
          margin: lift(t.margin, t.arm.units, c.margin, c.arm.units),
        },
      };
    });
  return { from: period.from.toISOString(), to: period.to.toISOString(), types, renewals };
}
