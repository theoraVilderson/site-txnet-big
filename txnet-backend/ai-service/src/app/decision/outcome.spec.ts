import { describe, expect, it } from 'vitest';

import { matchOutcome, measured, outcomeWrite, upliftReport, type OutcomeEvent, type ReportRow } from './outcome';

/**
 * F-038-i (ADR-0109 point 13): a suggestion is accepted when the purchase or
 * top-up it suggested happens within 7 days; the report is uplift against the
 * holdout per type — revenue, margin, renewals. The holdout's would-be
 * suggestions are measured the same way, so the two arms are comparable.
 */
const H = 3_600_000;
const D = 24 * H;
const t0 = new Date('2026-10-01T10:00:00Z');
const at = (ms: number) => new Date(t0.getTime() + ms);

const target = (over: Record<string, unknown> = {}) => ({
  code: 'suggest_variant',
  grantId: 'g-1',
  fromVariantId: 'v-small',
  variantId: 'v-small',
  price: '10.00',
  currencyCode: 'USD',
  ...over,
});
const margin = (cost: string | null, currencyCode = 'USD') => ({ code: 'expected_margin', price: '10.00', cost, costKnown: cost !== null, currencyCode });

describe('matchOutcome (F-038-i)', () => {
  const renew = { actionType: 'renew', subjectId: 'u-1', createdAt: t0, sentAt: at(H), reasons: [target(), margin('4.00')] };
  const purchase = (over: Partial<OutcomeEvent> = {}): OutcomeEvent => ({
    kind: 'purchase', ref: 'inv-1', userId: 'u-1', at: at(2 * D), variantId: 'v-small', grantId: null, amount: '9.00', currencyCode: 'USD', ...over,
  });

  it('a paid invoice for the suggested plan within 7 days of the suggestion is its outcome, at what was paid', () => {
    expect(matchOutcome(renew, [purchase()])).toEqual({ at: at(2 * D), ref: 'inv-1', amount: '9.00', currencyCode: 'USD' });
  });

  it('the window closes 7 days after the send, and nothing before the decision counts', () => {
    expect(matchOutcome(renew, [purchase({ at: at(H + 7 * D + 1) })])).toBeNull();
    expect(matchOutcome(renew, [purchase({ at: at(H + 7 * D) })])).not.toBeNull();
    expect(matchOutcome(renew, [purchase({ at: at(-1) })])).toBeNull();
  });

  it('a holdout row, never sent, is measured from its decision', () => {
    const held = { ...renew, sentAt: null };
    expect(matchOutcome(held, [purchase({ at: at(7 * D + 1) })])).toBeNull();
    expect(matchOutcome(held, [purchase({ at: at(7 * D) })])).not.toBeNull();
  });

  it("only the subject's own events, and the earliest of them", () => {
    expect(matchOutcome(renew, [purchase({ userId: 'u-2' })])).toBeNull();
    expect(matchOutcome(renew, [purchase({ ref: 'late', at: at(3 * D) }), purchase({ ref: 'early', at: at(2 * D) })])?.ref).toBe('early');
  });

  it("renew: the user's own renewal of the Grant counts, at the price the suggestion named", () => {
    const renewal: OutcomeEvent = { kind: 'renewal', ref: 'ren-1', userId: 'u-1', at: at(D), variantId: null, grantId: 'g-1', amount: null, currencyCode: null };
    expect(matchOutcome(renew, [renewal])).toEqual({ at: at(D), ref: 'ren-1', amount: '10.00', currencyCode: 'USD' });
    expect(matchOutcome(renew, [{ ...renewal, grantId: 'g-other' }])).toBeNull();
  });

  it('a resize counts only a purchase of the plan it named, never a renewal of the old one', () => {
    const up = { ...renew, actionType: 'resize_up', reasons: [target({ variantId: 'v-big' })] };
    expect(matchOutcome(up, [purchase({ variantId: 'v-small' })])).toBeNull();
    expect(matchOutcome(up, [{ kind: 'renewal', ref: 'r', userId: 'u-1', at: at(D), variantId: null, grantId: 'g-1', amount: null, currencyCode: null }])).toBeNull();
    expect(matchOutcome(up, [purchase({ variantId: 'v-big', amount: '20.00' })])?.amount).toBe('20.00');
  });

  it('top_up_wallet counts a gateway top-up; a type with no matcher never converts', () => {
    const top = { ...renew, actionType: 'top_up_wallet', reasons: [{ code: 'wallet_need' }] };
    const topUp: OutcomeEvent = { kind: 'top_up', ref: 'tx-1', userId: 'u-1', at: at(D), variantId: null, grantId: null, amount: '50.00', currencyCode: 'USD' };
    expect(matchOutcome(top, [topUp])?.amount).toBe('50.00');
    expect(matchOutcome({ ...renew, actionType: 'win_back' }, [purchase(), topUp])).toBeNull();
  });
});

describe('measured and outcomeWrite (F-038-i)', () => {
  it('a row is measured once it reached the holdout step; one stopped before it is not', () => {
    expect(measured({ status: 'sent', suppressedBy: null })).toBe(true);
    expect(measured({ status: 'suppressed', suppressedBy: 'holdout' })).toBe(true);
    expect(measured({ status: 'suppressed', suppressedBy: 'attention_budget' })).toBe(true);
    for (const step of ['confidence_threshold', 'opt_out', 'cooldown', 'quiet_down', 'type_disabled']) {
      expect(measured({ status: 'suppressed', suppressedBy: step })).toBe(false);
    }
  });

  it('a sent suggestion becomes accepted; a queued one is stopped, never told after the purchase; the rest keep their status', () => {
    expect(outcomeWrite('sent')).toEqual({ status: 'accepted' });
    expect(outcomeWrite('scheduled')).toEqual({ status: 'suppressed', suppressedBy: 'outcome_reached' });
    expect(outcomeWrite('awaiting_approval')).toEqual({ status: 'suppressed', suppressedBy: 'outcome_reached' });
    for (const s of ['suppressed', 'dismissed', 'expired']) expect(outcomeWrite(s)).toEqual({});
  });
});

describe('upliftReport (F-038-i)', () => {
  const period = { from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-10-01T00:00:00Z') };
  const row = (over: Partial<ReportRow>): ReportRow => ({
    subjectId: 'u-1',
    actionType: 'renew',
    status: 'sent',
    suppressedBy: null,
    createdAt: new Date('2026-09-10T00:00:00Z'),
    deadline: new Date('2026-09-15T00:00:00Z'),
    reasons: [target(), margin('4.00')],
    convertedAt: null,
    convertedAmount: null,
    convertedCurrency: null,
    ...over,
  });
  const bought = { convertedAt: new Date('2026-09-11T00:00:00Z'), convertedAmount: '10.00', convertedCurrency: 'USD' };
  const holdout = { status: 'suppressed', suppressedBy: 'holdout' } as const;

  it('per type: each arm’s units, conversions, rate, revenue and margin, and the uplift between them', () => {
    const rows = [
      row({ subjectId: 'a', status: 'accepted', ...bought }),
      row({ subjectId: 'b', status: 'accepted', ...bought }),
      row({ subjectId: 'c' }),
      row({ subjectId: 'd', status: 'expired' }),
      row({ subjectId: 'h1', ...holdout, ...bought }),
      row({ subjectId: 'h2', ...holdout }),
      row({ subjectId: 'h3', ...holdout }),
      row({ subjectId: 'h4', ...holdout }),
    ];
    const [renew] = upliftReport(rows, period).types;
    expect(renew.actionType).toBe('renew');
    expect(renew.treated).toEqual({ units: 4, converted: 2, rate: 0.5, revenue: [{ amount: '20.00', currencyCode: 'USD' }], margin: [{ amount: '12.00', currencyCode: 'USD' }], marginUnknown: 0 });
    expect(renew.control).toEqual({ units: 4, converted: 1, rate: 0.25, revenue: [{ amount: '10.00', currencyCode: 'USD' }], margin: [{ amount: '6.00', currencyCode: 'USD' }], marginUnknown: 0 });
    // Per treated unit (20/4 − 10/4) × 4 treated units.
    expect(renew.uplift).toEqual({ rate: 0.25, revenue: [{ amount: '10.00', currencyCode: 'USD' }], margin: [{ amount: '6.00', currencyCode: 'USD' }] });
    expect(upliftReport(rows, period).renewals).toEqual({ treated: 2, control: 1 });
  });

  it('one opportunity is one unit, however many daily rows it wrote; a stopped-early row is no unit', () => {
    const days = [10, 11, 12].map((d) => new Date(`2026-09-${d}T00:00:00Z`));
    const rows = [
      ...days.map((createdAt) => row({ subjectId: 'h', ...holdout, createdAt })),
      ...days.map((createdAt) => row({ subjectId: 't', status: 'suppressed', suppressedBy: 'attention_budget', createdAt })),
      row({ subjectId: 't', createdAt: days[2]! }),
      row({ subjectId: 'x', status: 'suppressed', suppressedBy: 'cooldown' }),
    ];
    const [renew] = upliftReport(rows, period).types;
    expect(renew.treated.units).toBe(1);
    expect(renew.control.units).toBe(1);
  });

  it('only units decided in the period count', () => {
    const rows = [row({ createdAt: new Date('2026-10-01T00:00:00Z') }), row({ subjectId: 'b', createdAt: new Date('2026-08-31T23:59:59Z') })];
    expect(upliftReport(rows, period).types).toEqual([]);
  });

  it('margin is unknown, never guessed, without a cost or across currencies; money is kept per currency', () => {
    const rows = [
      row({ subjectId: 'a', status: 'accepted', ...bought, reasons: [target(), margin(null)] }),
      row({ subjectId: 'b', status: 'accepted', convertedAt: bought.convertedAt, convertedAmount: '500000.00', convertedCurrency: 'IRR' }),
    ];
    const [renew] = upliftReport(rows, period).types;
    expect(renew.treated.marginUnknown).toBe(2);
    expect(renew.treated.margin).toEqual([]);
    expect(renew.treated.revenue).toEqual([
      { amount: '500000.00', currencyCode: 'IRR' },
      { amount: '10.00', currencyCode: 'USD' },
    ]);
  });

  it('with an empty control arm there is no uplift to state', () => {
    const [renew] = upliftReport([row({ status: 'accepted', ...bought })], period).types;
    expect(renew.control.rate).toBeNull();
    expect(renew.uplift).toEqual({ rate: null, revenue: [], margin: [] });
  });
});
