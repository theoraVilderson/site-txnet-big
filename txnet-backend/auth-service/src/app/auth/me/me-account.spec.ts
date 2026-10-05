import * as argon2 from 'argon2';
import { BadRequestException } from '@nestjs/common';
import { MeAccountService } from './me-account.service';
import type { AuthClaims } from '../token.service';

/**
 * The signed-in user's own name and password (UX-1-t, panel-web/contract.ux.md
 * S3–S4). The password change is the reset's rules with one more gate — the
 * current password — and, unlike a reset, it ends the *other* places only
 * when asked, through SES-1-a's `terminateOthers`, never this one.
 */

const CLAIMS = { sub: 'user-1', tenantId: 'tenant-1', sessionId: 'sess-1' } as AuthClaims;
const CURRENT = 'Old-pass1!';

async function harness() {
  const passwordHash = await argon2.hash(CURRENT, { type: argon2.argon2id });
  const prisma = {
    user: {
      findUnique: vi.fn(async () => ({ passwordHash, username: 'behnam', fullName: 'Behnam Tabrizi', phoneNumber: '+989121234567' })),
      update: vi.fn(async ({ data }: { data: Record<string, string> }) => ({ fullName: data.fullName ?? 'Behnam Tabrizi' })),
    },
  };
  const sessions = { terminateOthers: vi.fn(async () => ({ ok: true, msg: 'auth.otherSessionsTerminated', data: { terminated: 2 } })) };
  return { prisma, sessions, service: new MeAccountService(prisma as never, sessions as never) };
}

describe('MeAccountService', () => {
  it("renames the caller's own row", async () => {
    const { service, prisma } = await harness();
    const out = await service.rename(CLAIMS, 'Behnam T');

    expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'user-1' }, data: { fullName: 'Behnam T' } }));
    expect(out).toMatchObject({ ok: true, data: { fullName: 'Behnam T' } });
  });

  it('refuses a wrong current password as 400 wrong_password, and writes nothing', async () => {
    const { service, prisma, sessions } = await harness();
    const refusal = await service
      .changePassword(CLAIMS, { currentPassword: 'nope', newPassword: 'New-pass2!', endOtherSessions: true })
      .catch((e: unknown) => e);

    expect(refusal).toBeInstanceOf(BadRequestException);
    expect((refusal as BadRequestException).getResponse()).toMatchObject({ reason: 'wrong_password' });
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(sessions.terminateOthers).not.toHaveBeenCalled();
  });

  it('refuses a new password that holds the profile, as the register form does', async () => {
    const { service, prisma } = await harness();
    const out = await service.changePassword(CLAIMS, { currentPassword: CURRENT, newPassword: 'Behnam-99x', endOtherSessions: false });

    expect(out).toMatchObject({ ok: false, msg: 'password.containsProfileData' });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('rewrites the hash and ends every other place when asked', async () => {
    const { service, prisma, sessions } = await harness();
    const out = await service.changePassword(CLAIMS, { currentPassword: CURRENT, newPassword: 'New-pass2!', endOtherSessions: true });

    const { data } = prisma.user.update.mock.calls[0][0] as { data: { passwordHash: string } };
    expect(await argon2.verify(data.passwordHash, 'New-pass2!')).toBe(true);
    expect(sessions.terminateOthers).toHaveBeenCalledWith(CLAIMS);
    expect(out).toMatchObject({ ok: true, data: { otherSessionsEnded: 2 } });
  });

  it('leaves the other places signed in when not asked', async () => {
    const { service, sessions } = await harness();
    const out = await service.changePassword(CLAIMS, { currentPassword: CURRENT, newPassword: 'New-pass2!', endOtherSessions: false });

    expect(sessions.terminateOthers).not.toHaveBeenCalled();
    expect(out).toMatchObject({ ok: true, data: { otherSessionsEnded: 0 } });
  });
});
