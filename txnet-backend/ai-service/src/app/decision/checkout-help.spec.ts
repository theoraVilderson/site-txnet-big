import { candidatesFor, CHECKOUT_HELP_DEADLINE_MS, CHECKOUT_HELP_WAIT_MS, type CandidateInputs, type CheckoutAttempt } from './candidates';
import { deliveryItem } from './delivery';
import { matchOutcome, type OutcomeEvent } from './outcome';
import { quietDownVerdict } from './quiet-down';

/**
 * F-038-m / ADR-0109 point 9: `checkout_help` — a gateway payment started and
 * not paid (`failed`, or `expired` unfinished) gets one help message naming
 * another gateway, after the attempt and never on its path; a failed payment's
 * quiet-down does not silence it (F-1506).
 *
 * The failures worth a spec: help sent while the user is still on the bank's
 * page; help after they paid anyway; help a week late; two for one attempt; a
 * help message ranked as a sale (it moves no money the seller earns).
 */

const NOW = new Date('2026-10-05T09:20:00Z');
const MIN = 60_000;

const attempt = (minutesAgo: number, over: Partial<CheckoutAttempt> = {}): CheckoutAttempt => ({
  paymentId: `pay-${minutesAgo}`,
  status: 'failed',
  at: new Date(NOW.getTime() - minutesAgo * MIN),
  amount: '500000.00',
  currencyCode: 'IRR',
  ...over,
});

const inputs = (checkouts: CheckoutAttempt[], paidAt: Date | null = null): CandidateInputs => ({
  predictions: [],
  grants: new Map(),
  plans: new Map(),
  checkouts,
  lastPaidAt: paidAt,
});

describe('checkout_help candidates (F-038-m)', () => {
  it('helps with the latest unfinished attempt once the user had time to retry: help, not a sale', () => {
    const out = candidatesFor(inputs([attempt(240), attempt(45)]), NOW);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      actionType: 'checkout_help',
      confidence: 0.7,
      templateKey: 'suggestion.checkout_help',
      deadline: new Date(NOW.getTime() - 45 * MIN + CHECKOUT_HELP_DEADLINE_MS),
      // It earns the seller nothing by itself: it never outranks a sale on margin.
      expectedMargin: { amount: '0.00', currencyCode: 'IRR' },
    });
    expect(out[0].grantId).toBeUndefined();
    expect(out[0].reasons[0]).toEqual({ code: 'checkout_attempt', paymentId: 'pay-45', status: 'failed', amount: '500000.00', currencyCode: 'IRR', at: new Date(NOW.getTime() - 45 * MIN).toISOString() });
  });

  it('waits while the user may still be finishing it, and gives up past the deadline', () => {
    expect(candidatesFor(inputs([attempt(CHECKOUT_HELP_WAIT_MS / MIN - 1)]), NOW)).toEqual([]);
    expect(candidatesFor(inputs([attempt(CHECKOUT_HELP_DEADLINE_MS / MIN + 1)]), NOW)).toEqual([]);
    expect(candidatesFor(inputs([attempt(60, { status: 'expired' })]), NOW)).toHaveLength(1);
  });

  it('says nothing once the user paid after it', () => {
    expect(candidatesFor(inputs([attempt(90)], new Date(NOW.getTime() - 30 * MIN)), NOW)).toEqual([]);
    // A payment before the attempt is no answer to it.
    expect(candidatesFor(inputs([attempt(90)], new Date(NOW.getTime() - 120 * MIN)), NOW)).toHaveLength(1);
  });

  it('passes the quiet-down a failed payment sets, which holds every other type', () => {
    const calm = { openTicket: false, lastFailedPaymentAt: new Date(NOW.getTime() - 45 * MIN) };
    expect(quietDownVerdict(calm, 'checkout_help', NOW)).toEqual({ pass: true });
    expect(quietDownVerdict(calm, 'renew', NOW)).toMatchObject({ pass: false });
  });
});

describe('checkout_help delivery and outcome (F-038-m)', () => {
  const reasons = [{ code: 'checkout_attempt', paymentId: 'pay-45', status: 'failed', amount: '500000.00', currencyCode: 'IRR', at: '2026-10-05T08:35:00.000Z' }];

  it('is delivered with no Grant and the attempt it helps with', () => {
    const row = {
      id: 'a1', tenantId: 't1', subjectKind: 'user' as const, subjectId: 'u1', actionType: 'checkout_help' as const, status: 'scheduled' as const,
      templateKey: 'suggestion.checkout_help', renderedBy: 'template' as const, renderedText: null, deadline: new Date(NOW.getTime() + 3_600_000), reasons,
    };
    expect(deliveryItem(row)).toMatchObject({ grantId: null, variantId: null, payment: { paymentId: 'pay-45', amount: { amount: '500000.00', currencyCode: 'IRR' } } });
  });

  it('converts on a gateway top-up after it, inside the window', () => {
    const action = { actionType: 'checkout_help', subjectId: 'u1', createdAt: NOW, sentAt: NOW, reasons };
    const topUp = (minutesAfter: number): OutcomeEvent => ({
      kind: 'top_up', ref: 'tx', userId: 'u1', at: new Date(NOW.getTime() + minutesAfter * MIN), variantId: null, grantId: null, amount: '500000.00', currencyCode: 'IRR',
    });
    expect(matchOutcome(action, [topUp(30)])).toMatchObject({ ref: 'tx', amount: '500000.00' });
    expect(matchOutcome(action, [topUp(8 * 24 * 60)])).toBeNull();
  });
});
