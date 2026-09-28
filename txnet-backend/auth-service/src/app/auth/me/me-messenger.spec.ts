import { MeMessengerService } from './me-messenger.service';
import type { AuthClaims } from '../token.service';

/**
 * Which messenger a user's notices take (F-601-u, ADR-0097 part 2): Telegram,
 * Bale or both, and unchosen is both. The column is `null` until the user
 * picks, so the answer says `chosen` beside the effective value — the panel
 * shows "both" either way, and a later default can still tell them apart.
 */

const CLAIMS = { sub: 'user-1', tenantId: 'tenant-1' } as AuthClaims;

function harness(stored: string | null, linked: string[] = ['telegram']) {
  const prisma = {
    user: {
      findUnique: vi.fn(async () => ({ noticeMessenger: stored, linkedBotAccounts: linked.map((platform) => ({ platform })) })),
      update: vi.fn(async ({ data }: { data: { noticeMessenger: string } }) => ({
        noticeMessenger: data.noticeMessenger,
        linkedBotAccounts: linked.map((platform) => ({ platform })),
      })),
    },
  };
  return { prisma, service: new MeMessengerService(prisma as never) };
}

describe('MeMessengerService', () => {
  it('reads an unchosen messenger as both, and says it was not chosen', async () => {
    const { service, prisma } = harness(null, ['telegram', 'bale']);
    const out = await service.read(CLAIMS);

    expect(out).toMatchObject({ ok: true, data: { messenger: 'both', chosen: false, linked: ['telegram', 'bale'] } });
    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'user-1' },
        select: expect.objectContaining({
          linkedBotAccounts: expect.objectContaining({ where: { contactVerifiedAt: { not: null } } }),
        }),
      }),
    );
  });

  it('reads a chosen messenger as it was saved', async () => {
    const { service } = harness('bale');
    expect(await service.read(CLAIMS)).toMatchObject({ data: { messenger: 'bale', chosen: true, linked: ['telegram'] } });
  });

  it("saves the caller's own row, and a messenger not linked yet is allowed — the notifier falls back", async () => {
    const { service, prisma } = harness(null, ['telegram']);
    const out = await service.save(CLAIMS, 'bale');

    expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'user-1' }, data: { noticeMessenger: 'bale' } }));
    expect(out).toMatchObject({ ok: true, data: { messenger: 'bale', chosen: true, linked: ['telegram'] } });
  });
});
