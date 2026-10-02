import { matchResellerOutcome, type ResellerEvent } from './outcome';

/**
 * F-038-o5 (ADR-0109 point 13): a reseller's suggestion converts only on what
 * it named, by that reseller, inside its window — the same rule a user's
 * holds (invariant 22).
 *
 * The failures worth a spec: an upgrade to another package counted as the one
 * named; an upgrade before the decision, or past the window, counted; a top-up
 * credited to a pitch about the package; another reseller's event counted.
 */

const DAY = 86_400_000;
const decided = new Date('2026-10-02T12:00:00Z');
const sent = new Date('2026-10-03T12:00:00Z');
const at = (d: Date, ms: number) => new Date(d.getTime() + ms);

const upgrade = { actionType: 'resize_up', subjectId: 'r-1', createdAt: decided, sentAt: sent, reasons: [{ code: 'suggest_package', fromPackageId: 'silver', packageId: 'gold' }] };
const topUp = { actionType: 'top_up_wallet', subjectId: 'r-1', createdAt: decided, sentAt: sent, reasons: [{ code: 'suggest_top_up', amount: '510.00', currencyCode: 'USD' }] };
const charge = (when: Date, over: Partial<ResellerEvent> = {}): ResellerEvent => ({ kind: 'upgrade', ref: 'tx-1', tenantId: 'r-1', at: when, amount: '40.00', currencyCode: 'USD', ...over });

describe('matchResellerOutcome (F-038-o5)', () => {
  it('an upgrade converts on the upgrade charge inside the window, when the reseller is now on the package named', () => {
    expect(matchResellerOutcome(upgrade, [charge(at(sent, DAY))], 'gold')).toEqual({ at: at(sent, DAY), ref: 'tx-1', amount: '40.00', currencyCode: 'USD' });
  });

  it('not to another package, not before the decision, not past 7 days after the send, not another reseller\'s', () => {
    expect(matchResellerOutcome(upgrade, [charge(at(sent, DAY))], 'platinum')).toBeNull();
    expect(matchResellerOutcome(upgrade, [charge(at(decided, -DAY))], 'gold')).toBeNull();
    expect(matchResellerOutcome(upgrade, [charge(at(sent, 8 * DAY))], 'gold')).toBeNull();
    expect(matchResellerOutcome(upgrade, [charge(at(sent, DAY), { tenantId: 'r-2' })], 'gold')).toBeNull();
  });

  it('a top-up converts on a billing-wallet top-up in the window — never on an upgrade charge', () => {
    const credit = charge(at(sent, DAY), { kind: 'top_up', ref: 'tx-2', amount: '600.00' });
    expect(matchResellerOutcome(topUp, [charge(at(sent, DAY))], null)).toBeNull();
    expect(matchResellerOutcome(topUp, [credit], null)).toEqual({ at: at(sent, DAY), ref: 'tx-2', amount: '600.00', currencyCode: 'USD' });
  });
});
