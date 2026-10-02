/**
 * F-038-g5: an AI suggestion about no service — `checkout_help` after a failed
 * top-up (F-038-m), a reseller's own suggestion (F-038-o) — claimed and held
 * on the same ledger, keyed by its action alone. What would break silently:
 *
 *  - **once per action** still: a redelivered claim of a held one answers
 *    `held` again, found by the action, never by a Grant it does not have;
 *  - **mute and quiet hours** still hold — they are the user's, not a
 *    service's;
 *  - **no Grant is invented**: the 24 h-after-retention rule and the
 *    `essential` level are about one service, so neither is read;
 *  - **a claim that says nothing about a Grant is still a claim**: the body
 *    may leave `grantId` out, never send it empty.
 */
import { SUGGESTION_NOTICE } from '@txnet-backend/shared-core';

import { RetentionLedgerService } from './retention-ledger.service';
import { retentionHoldSchema, suggestionClaimSchema } from './retention-ledger.schema';

const USER = '44444444-4444-4444-8444-444444444444';
const ACTION = '77777777-7777-4777-8777-777777777777';
const TENANT = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-05T09:20:00Z'); // 12:50 in Tehran

function ledger(over: { existing?: unknown; pref?: unknown } = {}) {
  const retentionNotice = {
    createMany: vi.fn().mockResolvedValue({ count: over.existing ? 0 : 1 }),
    findUnique: vi.fn().mockResolvedValue(null),
    findFirst: vi.fn().mockResolvedValue(over.existing ?? null),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    count: vi.fn().mockResolvedValue(0),
  };
  const preferences = { stored: vi.fn().mockResolvedValue(over.pref ?? null) };
  const levels = { level: vi.fn().mockResolvedValue('essential') };
  return { retentionNotice, levels, service: new RetentionLedgerService({ retentionNotice } as never, preferences as never, levels as never) };
}

const claim = { actionId: ACTION, userId: USER };

describe('a suggestion with no Grant (F-038-g5)', () => {
  it('is claimed once, keyed by its action, with no Grant written and none read', async () => {
    const { service, retentionNotice, levels } = ledger();
    await expect(service.claimSuggestion(claim, NOW)).resolves.toEqual({ deliver: 'now' });
    expect(retentionNotice.createMany).toHaveBeenCalledWith({
      data: [{ eventId: ACTION, userId: USER, grantId: null, notice: SUGGESTION_NOTICE, period: ACTION }],
      skipDuplicates: true,
    });
    // No retention rule and no service level: both are about a Grant.
    expect(retentionNotice.findFirst).not.toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ notice: { not: SUGGESTION_NOTICE } }) }));
    expect(levels.level).not.toHaveBeenCalled();
  });

  it('a redelivered claim of a held one is found by its action and answers held again', async () => {
    const held = { eventId: ACTION, botAt: new Date('2026-10-05T10:30:00Z'), botTemplate: 'suggestionCheckoutHelp' };
    const { service, retentionNotice } = ledger({ existing: held });
    await expect(service.claimSuggestion(claim, NOW)).resolves.toEqual({ deliver: 'held', botAt: '2026-10-05T10:30:00.000Z' });
    expect(retentionNotice.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { grantId: null, notice: SUGGESTION_NOTICE, period: ACTION } }));
  });

  it('is muted by the user\'s suggestion mute, and held by their quiet hours', async () => {
    await expect(ledger({ pref: { mutedKinds: ['suggestion'], quietStart: null, quietEnd: null, timezone: null } }).service.claimSuggestion(claim, NOW)).resolves.toEqual({ deliver: 'muted' });
    const lunch = { mutedKinds: [], quietStart: 12 * 60, quietEnd: 14 * 60, timezone: 'Asia/Tehran' };
    await expect(ledger({ pref: lunch }).service.claimSuggestion(claim, NOW)).resolves.toEqual({ deliver: 'held', botAt: '2026-10-05T10:30:00.000Z' });
  });

  it('holds its bot message on the row of its action', async () => {
    const { service, retentionNotice } = ledger();
    const hold = { eventId: ACTION, notice: SUGGESTION_NOTICE, period: ACTION, tenantId: TENANT, template: 'suggestionCheckoutHelp', params: {}, botAt: '2026-10-05T10:30:00.000Z' };
    expect(retentionHoldSchema.safeParse(hold).success).toBe(true);
    await expect(service.hold(hold, NOW)).resolves.toEqual({ held: true });
    expect(retentionNotice.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { grantId: null, notice: SUGGESTION_NOTICE, period: ACTION, eventId: ACTION, botTemplate: null } }));
  });

  it('takes a claim without a Grant, never one with an empty or malformed one', () => {
    expect(suggestionClaimSchema.safeParse(claim).success).toBe(true);
    expect(suggestionClaimSchema.safeParse({ ...claim, grantId: '' }).success).toBe(false);
    expect(suggestionClaimSchema.safeParse({ ...claim, grantId: null }).success).toBe(false);
  });
});
