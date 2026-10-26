import { OtpChannel, OtpPurpose } from '@prisma/client';
import { OWNER_SETUP_PURPOSE } from '../token.service';
import { offerOwnerSetup } from './offer-owner-setup';
import { OwnerSetupService } from './owner-setup.service';

vi.mock('argon2', () => ({ hash: vi.fn(async () => 'argon2-hash'), argon2id: 2 }));

/**
 * F-0102: a fresh install's owner signs in with the sealed first password and
 * gets no session — only a setup token. The session exists once the owner has
 * set their own username, password and a phone proved by a code; until then
 * nothing else admits the token (it carries no session id).
 */
describe('owner setup (F-0102)', () => {
  const PHONE = '+989121234567';
  const OWNER = { id: 'u-owner', fullName: 'Platform Owner', setupRequired: true, deletedAt: null };

  const build = (o: { claims?: unknown; user?: unknown; holder?: unknown; codeValid?: boolean; written?: number; writeError?: unknown } = {}) => {
    const tokens = {
      verify: vi.fn(() => ('claims' in o ? o.claims : { sub: 'u-owner', purpose: OWNER_SETUP_PURPOSE })),
      signSetupToken: vi.fn(() => 'setup-token'),
    };
    const prisma = {
      user: {
        findUnique: vi.fn(async () => ('user' in o ? o.user : OWNER)),
        findFirst: vi.fn(async () => o.holder ?? null),
        updateMany: vi.fn(async () => {
          if (o.writeError) throw o.writeError;
          return { count: o.written ?? 1 };
        }),
      },
    };
    const codes = { send: vi.fn(async () => ({ ok: true, msg: 'auth.ownerSetupCodeSent', data: { requiresPhoneVerification: true } })) };
    const otp = { verifyOtp: vi.fn(async () => o.codeValid ?? true) };
    const botLinks = { promoteProvenChat: vi.fn(async () => undefined) };
    const auth = {
      findUserForSession: vi.fn(async () => ({ id: 'u-owner' })),
      createSessionForUser: vi.fn(async () => ({ accessToken: 'at', refreshToken: 'rt' })),
    };
    const service = new OwnerSetupService(prisma as never, tokens as never, codes as never, otp as never, botLinks as never, auth as never);
    return { service, prisma, codes, otp, botLinks, auth };
  };

  const complete = (h: ReturnType<typeof build>, over: Record<string, unknown> = {}) =>
    h.service.complete(
      { setupToken: 'setup-token', username: 'theora', newPassword: 'Str0ng!Secret', phoneNumber: PHONE, otpCode: '123456', ...over },
      { ip: '1.2.3.4', userAgent: 'ua', scopeKey: null },
    );

  describe('the password step', () => {
    it('answers a setup token, and no session, for an owner still on the seed account', () => {
      const tokens = { signSetupToken: vi.fn(() => 'setup-token') };
      expect(offerOwnerSetup({ id: 'u-owner', setupRequired: true }, tokens)).toEqual({
        ok: true,
        msg: 'auth.ownerSetupRequired',
        data: { setupRequired: true, setupToken: 'setup-token' },
      });
    });

    it('lets every other account through to its usual sign-in', () => {
      expect(offerOwnerSetup({ id: 'u-1', setupRequired: false }, { signSetupToken: vi.fn() })).toBeNull();
    });
  });

  describe('sending the code', () => {
    it("sends a phone-proof code to the owner's new number", async () => {
      const h = build();
      await h.service.sendCode({ setupToken: 'setup-token', phoneNumber: PHONE, channel: OtpChannel.sms }, '1.2.3.4', 'fa');
      expect(h.codes.send).toHaveBeenCalledWith(PHONE, OtpPurpose.register_phone_verify, expect.objectContaining({ chosen: OtpChannel.sms, sentKey: 'auth.ownerSetupCodeSent' }));
    });

    it('refuses a token of any other step, and sends nothing', async () => {
      const h = build({ claims: { sub: 'u-owner', purpose: 'otp_login' } });
      expect(await h.service.sendCode({ setupToken: 't', phoneNumber: PHONE }, '1.2.3.4', 'fa')).toMatchObject({ ok: false, msg: 'auth.invalidSetupToken' });
      expect(h.codes.send).not.toHaveBeenCalled();
    });

    it('refuses an account whose setup is already done', async () => {
      const h = build({ user: { ...OWNER, setupRequired: false } });
      expect(await h.service.sendCode({ setupToken: 't', phoneNumber: PHONE }, '1.2.3.4', 'fa')).toMatchObject({ ok: false, msg: 'auth.invalidSetupToken' });
      expect(h.codes.send).not.toHaveBeenCalled();
    });

    it('refuses a number another account already holds', async () => {
      const h = build({ holder: { id: 'u-other' } });
      expect(await h.service.sendCode({ setupToken: 't', phoneNumber: PHONE }, '1.2.3.4', 'fa')).toMatchObject({ ok: false, msg: 'auth.ownerSetupPhoneTaken' });
      expect(h.codes.send).not.toHaveBeenCalled();
    });
  });

  describe('completing it', () => {
    it("writes the owner's username, password and proved phone, then opens the session on both factors", async () => {
      const h = build();
      expect(await complete(h)).toMatchObject({ ok: true, msg: 'auth.ownerSetupDone', data: { accessToken: 'at' } });
      expect(h.otp.verifyOtp).toHaveBeenCalledWith(PHONE, OtpPurpose.register_phone_verify, '123456');
      expect(h.prisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: 'u-owner', setupRequired: true },
        data: expect.objectContaining({ username: 'theora', passwordHash: 'argon2-hash', phoneNumber: PHONE, setupRequired: false, phoneVerifiedAt: expect.any(Date) }),
      });
      expect(h.botLinks.promoteProvenChat).toHaveBeenCalledWith('u-owner', PHONE);
      expect(h.auth.createSessionForUser).toHaveBeenCalledWith({ id: 'u-owner' }, '1.2.3.4', 'ua', null, null, true);
    });

    it('a wrong code writes nothing and opens nothing', async () => {
      const h = build({ codeValid: false });
      expect(await complete(h)).toMatchObject({ ok: false, msg: 'otp.invalid' });
      expect(h.prisma.user.updateMany).not.toHaveBeenCalled();
      expect(h.auth.createSessionForUser).not.toHaveBeenCalled();
    });

    it('a second completion of the same setup opens nothing', async () => {
      const h = build({ written: 0 });
      expect(await complete(h)).toMatchObject({ ok: false, msg: 'auth.invalidSetupToken' });
      expect(h.auth.createSessionForUser).not.toHaveBeenCalled();
    });

    it('a username or number another account holds is told, not thrown', async () => {
      const h = build({ writeError: Object.assign(new Error('unique'), { code: 'P2002' }) });
      expect(await complete(h)).toMatchObject({ ok: false, msg: 'auth.ownerSetupTaken' });
      expect(h.auth.createSessionForUser).not.toHaveBeenCalled();
    });

    it('refuses a password that contains the chosen username (2.2), before any code is spent', async () => {
      const h = build();
      expect(await complete(h, { newPassword: 'Theora!2026x' })).toMatchObject({ ok: false, msg: 'password.containsProfileData' });
      expect(h.otp.verifyOtp).not.toHaveBeenCalled();
    });
  });
});
