/**
 * F-038-g1 (ADR-0109 points 10, 11): an AI suggestion is a notice of its own
 * class, `suggestion` — inbox and the user's messenger, mutable, held by quiet
 * hours — claimed on the retention ledger once per action. What would break
 * silently here, and nowhere else:
 *
 *  - **the deterministic notice wins.** A suggestion about a Grant that had a
 *    retention notice in the last 24 h is not told now; the claim says when
 *    it may be;
 *  - **a user who muted suggestions hears none**, nor on a Grant they set to
 *    essential — and the row is still written;
 *  - **quiet hours hold the bot**, and a redelivered claim of a held one
 *    answers `held` again, so the bot is never told twice;
 *  - **once per action**: a second claim by another action id names another
 *    row; the same id is the same row.
 */
import { NOTICE_CLASS_OF, noticeClassOf, RETENTION_MUTABLE_KINDS, SUGGESTION_NOTICE } from '@txnet-backend/shared-core';

import { preferencesSchema } from './notification-preferences.schema';
import { RetentionLedgerService } from './retention-ledger.service';
import { suggestionClaimSchema } from './retention-ledger.schema';

const USER = '44444444-4444-4444-8444-444444444444';
const GRANT = '99999999-9999-4999-8999-999999999991';
const ACTION = '77777777-7777-4777-8777-777777777777';
const NOW = new Date('2026-10-05T09:20:00Z'); // 12:50 in Tehran
const HOUR = 3_600_000;

function ledger(over: { existing?: unknown; lastRetention?: Date | null; pref?: unknown; essential?: boolean } = {}) {
  const retentionNotice = {
    createMany: vi.fn().mockResolvedValue({ count: over.existing ? 0 : 1 }),
    findUnique: vi.fn().mockResolvedValue(over.existing ?? null),
    findFirst: vi.fn().mockResolvedValue(over.lastRetention ? { createdAt: over.lastRetention } : null),
  };
  const preferences = { stored: vi.fn().mockResolvedValue(over.pref ?? null) };
  const levels = { level: vi.fn().mockResolvedValue(over.essential ? 'essential' : 'all') };
  return { retentionNotice, service: new RetentionLedgerService({ retentionNotice } as never, preferences as never, levels as never) };
}

const claim = { actionId: ACTION, userId: USER, grantId: GRANT };

describe('the suggestion class (F-038-g1)', () => {
  it('is its own class, a mutable kind, and weaker than important', () => {
    expect(NOTICE_CLASS_OF[SUGGESTION_NOTICE]).toBe('suggestion');
    expect(noticeClassOf(SUGGESTION_NOTICE, 'paymentCredited')).toBe('important');
    expect(RETENTION_MUTABLE_KINDS).toContain('suggestion');
    expect(preferencesSchema.safeParse({ muted: ['suggestion'], quietHours: null, timezone: null }).success).toBe(true);
  });
});

describe('RetentionLedgerService.claimSuggestion (F-038-g1)', () => {
  it('writes one ledger row per action and tells it now', async () => {
    const { service, retentionNotice } = ledger();
    await expect(service.claimSuggestion(claim, NOW)).resolves.toEqual({ deliver: 'now' });
    expect(retentionNotice.createMany).toHaveBeenCalledWith({
      data: [{ eventId: ACTION, userId: USER, grantId: GRANT, notice: SUGGESTION_NOTICE, period: ACTION }],
      skipDuplicates: true,
    });
  });

  it('waits 24 h after a retention notice on the same Grant — the deterministic notice wins', async () => {
    const told = new Date(NOW.getTime() - 3 * HOUR);
    const { service, retentionNotice } = ledger({ lastRetention: told });
    await expect(service.claimSuggestion(claim, NOW)).resolves.toEqual({ deliver: 'later', reason: 'after_retention', retryAt: new Date(told.getTime() + 24 * HOUR).toISOString() });
    expect(retentionNotice.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { grantId: GRANT, notice: { not: SUGGESTION_NOTICE }, createdAt: { gt: new Date(NOW.getTime() - 24 * HOUR) } } }),
    );
  });

  it('is muted for a user who muted suggestions, or on a Grant set to essential', async () => {
    await expect(ledger({ pref: { mutedKinds: ['suggestion'], quietStart: null, quietEnd: null, timezone: null } }).service.claimSuggestion(claim, NOW)).resolves.toEqual({ deliver: 'muted' });
    await expect(ledger({ essential: true }).service.claimSuggestion(claim, NOW)).resolves.toEqual({ deliver: 'muted' });
    // Muting usage notices says nothing about suggestions.
    await expect(ledger({ pref: { mutedKinds: ['usage'], quietStart: null, quietEnd: null, timezone: null } }).service.claimSuggestion(claim, NOW)).resolves.toEqual({ deliver: 'now' });
  });

  it('holds the bot inside the user quiet window, until its end', async () => {
    const lunch = { mutedKinds: [], quietStart: 12 * 60, quietEnd: 14 * 60, timezone: 'Asia/Tehran' };
    await expect(ledger({ pref: lunch }).service.claimSuggestion(claim, NOW)).resolves.toEqual({ deliver: 'held', botAt: '2026-10-05T10:30:00.000Z' });
  });

  it('answers held again for a row whose bot message is already kept', async () => {
    const existing = { eventId: ACTION, botAt: new Date('2026-10-05T10:30:00Z'), botTemplate: 'aiSuggestion' };
    const { service, retentionNotice } = ledger({ existing });
    await expect(service.claimSuggestion(claim, NOW)).resolves.toEqual({ deliver: 'held', botAt: '2026-10-05T10:30:00.000Z' });
    expect(retentionNotice.findFirst).not.toHaveBeenCalled();
  });

  it('takes a strict body', () => {
    expect(suggestionClaimSchema.safeParse(claim).success).toBe(true);
    expect(suggestionClaimSchema.safeParse({ ...claim, extra: 1 }).success).toBe(false);
    expect(suggestionClaimSchema.safeParse({ ...claim, grantId: 'x' }).success).toBe(false);
  });
});
