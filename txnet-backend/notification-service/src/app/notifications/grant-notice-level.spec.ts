/**
 * A buyer sets one service to essential notices only (F-601-o; invariant 15).
 * What would break silently here, and nowhere else:
 *
 *  - **essential mutes every kind but cutoff, on that Grant alone.** A usage,
 *    time, connect or "active again" notice of a Grant set to essential is
 *    claimed `muted`; the same notice of the buyer's other Grants is not;
 *  - **a stopped service is still told.** A cutoff or purge notice answers
 *    `now` on an essential Grant, without reading any setting;
 *  - **the level is the buyer's, not the Grant's.** It is read and written
 *    under the gate's `userId`, so a Grant id the caller does not own names a
 *    row no claim of theirs ever reads; `all` is no row at all.
 */
import { OutboxEventType } from '@txnet-backend/shared-core';

import { GrantNoticeLevelService } from './grant-notice-level.service';
import { grantNoticeLevelSchema } from './grant-notice-level.schema';
import { RetentionLedgerService } from './retention-ledger.service';

const USER = '44444444-4444-4444-8444-444444444444';
const FRIEND_GRANT = '99999999-9999-4999-8999-999999999991';
const OWN_GRANT = '99999999-9999-4999-8999-999999999992';
const EVENT = '88888888-8888-4888-8888-888888888888';

describe('RetentionLedgerService.claim — a Grant set to essential', () => {
  const at = new Date('2026-09-28T10:00:00Z');
  const claim = (notice: string, grantId = FRIEND_GRANT) => ({ eventId: EVENT, userId: USER, grantId, notice, period: 'p1' });

  function ledger(essential: string[]) {
    const retentionNotice = { createMany: vi.fn().mockResolvedValue({ count: 1 }), findUnique: vi.fn() };
    const preferences = { stored: vi.fn().mockResolvedValue(null) };
    const levels = { level: vi.fn(async (_user: string, grantId: string) => (essential.includes(grantId) ? 'essential' : 'all')) };
    return { retentionNotice, levels, service: new RetentionLedgerService({ retentionNotice } as never, preferences as never, levels as never) };
  }

  it('mutes every non-cutoff kind of that Grant — and still writes the row', async () => {
    for (const notice of [
      OutboxEventType.GRANT_USAGE_80,
      OutboxEventType.GRANT_ENDS_IN_3D,
      OutboxEventType.GRANT_IDLE,
      OutboxEventType.GRANT_REACTIVATED,
    ]) {
      const { retentionNotice, levels, service } = ledger([FRIEND_GRANT]);
      await expect(service.claim(claim(notice), at), notice).resolves.toEqual({ claimed: true, deliver: 'muted' });
      expect(levels.level).toHaveBeenCalledWith(USER, FRIEND_GRANT);
      expect(retentionNotice.createMany).toHaveBeenCalled();
    }
  });

  it("tells the same notice of the buyer's other Grant", async () => {
    const { service } = ledger([FRIEND_GRANT]);
    await expect(service.claim(claim(OutboxEventType.GRANT_USAGE_80, OWN_GRANT), at)).resolves.toEqual({ claimed: true, deliver: 'now' });
  });

  it('tells a cutoff or purge notice of an essential Grant now, without reading its level', async () => {
    for (const notice of [OutboxEventType.GRANT_ENDED, OutboxEventType.GRANT_VOLUME_SPENT, OutboxEventType.GRANT_PURGE_SOON]) {
      const { levels, service } = ledger([FRIEND_GRANT]);
      await expect(service.claim(claim(notice), at), notice).resolves.toEqual({ claimed: true, deliver: 'now' });
      expect(levels.level).not.toHaveBeenCalled();
    }
  });
});

describe('GrantNoticeLevelService', () => {
  function service(rows: { grantId: string }[] = []) {
    const notificationGrantPreference = {
      findMany: vi.fn().mockResolvedValue(rows),
      findUnique: vi.fn().mockResolvedValue(rows[0] ? { level: 'essential' } : null),
      upsert: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    };
    return { notificationGrantPreference, service: new GrantNoticeLevelService({ notificationGrantPreference } as never) };
  }

  it("lists only the caller's own essential Grants", async () => {
    const { notificationGrantPreference, service: s } = service([{ grantId: FRIEND_GRANT }]);
    await expect(s.list(USER)).resolves.toEqual({ essential: [FRIEND_GRANT] });
    expect(notificationGrantPreference.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: USER, level: 'essential' } }));
  });

  it('reads the level under the caller, and no row as all', async () => {
    const { notificationGrantPreference, service: s } = service();
    await expect(s.level(USER, FRIEND_GRANT)).resolves.toBe('all');
    expect(notificationGrantPreference.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId_grantId: { userId: USER, grantId: FRIEND_GRANT } } }),
    );
  });

  it('writes essential as a row of the caller, and all as none', async () => {
    const { notificationGrantPreference, service: s } = service();

    await expect(s.set(USER, FRIEND_GRANT, 'essential')).resolves.toEqual({ grantId: FRIEND_GRANT, level: 'essential' });
    expect(notificationGrantPreference.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId_grantId: { userId: USER, grantId: FRIEND_GRANT } } }),
    );

    await expect(s.set(USER, FRIEND_GRANT, 'all')).resolves.toEqual({ grantId: FRIEND_GRANT, level: 'all' });
    expect(notificationGrantPreference.deleteMany).toHaveBeenCalledWith({ where: { userId: USER, grantId: FRIEND_GRANT } });
  });

  it('refuses an unknown level and an unknown key', () => {
    expect(grantNoticeLevelSchema.safeParse({ level: 'essential' }).success).toBe(true);
    expect(grantNoticeLevelSchema.safeParse({ level: 'none' }).success).toBe(false);
    expect(grantNoticeLevelSchema.safeParse({ level: 'all', userId: USER }).success).toBe(false);
  });
});
