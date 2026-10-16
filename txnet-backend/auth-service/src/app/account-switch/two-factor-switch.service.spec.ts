import { OtpPurpose } from '@prisma/client';
import { TwoFactorSwitchService } from './two-factor-switch.service';

/**
 * ADR-0145 closes the one-click switch into a holder of `*`; this is the door
 * that stays open, because it proves both factors at the moment of the switch:
 * the member's own password, then a code to their own number. Neither step may
 * do anything for an account outside the caller's group — a code sent to a
 * stranger's phone is an oracle and a nuisance.
 */
describe('TwoFactorSwitchService (ADR-0145)', () => {
  const scope = 'web:panel.example' as never;
  const target = { id: 'u-star', username: 'theora', phoneNumber: '+989121234567' };

  const build = (o: { sameGroup?: boolean; proven?: unknown; target?: unknown } = {}) => {
    const member = (userId: string, groupId: string) => ({ userId, groupId });
    const prisma = {
      linkedAccountMember: {
        findUnique: vi.fn(async ({ where }: { where: { scopeKey_userId: { userId: string } } }) =>
          where.scopeKey_userId.userId === 'u-me'
            ? member('u-me', 'g-1')
            : member(where.scopeKey_userId.userId, o.sameGroup === false ? 'g-other' : 'g-1'),
        ),
      },
    };
    const auth = {
      proveAccountByPassword: vi.fn(async () => ('proven' in o ? o.proven : target)),
      askSecondFactor: vi.fn(async () => ({ ok: true, data: { requiresOtp: true, otpToken: 'tok' } })),
    };
    const accounts = { switchTo: vi.fn(async () => ({ ok: true, data: { accessToken: 'at' } })) };
    const surfaceOwners = { admissibleUser: vi.fn(async () => ('target' in o ? o.target : target)) };
    const tokens = { verify: vi.fn(() => ({ sub: 'u-star', purpose: 'otp_login' })) };
    const otp = { verifyOtp: vi.fn(async () => undefined) };
    const service = new TwoFactorSwitchService(
      prisma as never,
      auth as never,
      accounts as never,
      surfaceOwners as never,
      tokens as never,
      otp as never,
    );
    return { service, auth, accounts, tokens, otp };
  };

  const begin = (h: ReturnType<typeof build>, password = 'right') =>
    h.service.begin(scope, 'u-me', { userId: 'u-star', password }, '1.2.3.4', 'fa');
  const finish = (h: ReturnType<typeof build>) =>
    h.service.finish(scope, 'u-me', 's-me', { otpToken: 'tok', otpCode: '123456' }, '1.2.3.4', 'ua');

  it("proves the member's password, then sends the code to their number", async () => {
    const h = build();

    const result = await begin(h);

    expect(h.auth.proveAccountByPassword).toHaveBeenCalledWith('theora', 'right');
    expect(h.auth.askSecondFactor).toHaveBeenCalledWith(target, '1.2.3.4', 'fa', undefined);
    expect(result).toMatchObject({ ok: true, data: { otpToken: 'tok' } });
  });

  it('sends the code by the channel picked beside the password (SA-1-f)', async () => {
    const h = build();
    await h.service.begin(scope, 'u-me', { userId: 'u-star', password: 'right', channel: 'telegram' } as never, '1.2.3.4', 'fa');
    expect(h.auth.askSecondFactor).toHaveBeenCalledWith(target, '1.2.3.4', 'fa', 'telegram');
  });

  it('does nothing for an account outside the caller\'s group', async () => {
    const h = build({ sameGroup: false });

    expect(await begin(h)).toMatchObject({ ok: false });
    expect(h.auth.proveAccountByPassword).not.toHaveBeenCalled();
    expect(h.auth.askSecondFactor).not.toHaveBeenCalled();
  });

  it('a wrong password sends no code', async () => {
    const h = build({ proven: null });

    expect(await begin(h, 'wrong')).toMatchObject({ ok: false });
    expect(h.auth.askSecondFactor).not.toHaveBeenCalled();
  });

  it('checks the code on the number the token names, then switches as two-factor', async () => {
    const h = build();

    await finish(h);

    expect(h.otp.verifyOtp).toHaveBeenCalledWith(target.phoneNumber, OtpPurpose.login, '123456');
    expect(h.accounts.switchTo).toHaveBeenCalledWith(scope, 'u-me', 's-me', 'u-star', '1.2.3.4', 'ua', true);
    expect(h.otp.verifyOtp.mock.invocationCallOrder[0]).toBeLessThan(h.accounts.switchTo.mock.invocationCallOrder[0]);
  });

  it('a token minted for anything but the code step switches nothing', async () => {
    const h = build();
    h.tokens.verify.mockReturnValue({ sub: 'u-star', purpose: 'password_reset' });

    expect(await finish(h)).toMatchObject({ ok: false });
    expect(h.otp.verifyOtp).not.toHaveBeenCalled();
    expect(h.accounts.switchTo).not.toHaveBeenCalled();
  });
});
