import { OtpChannel, OtpPurpose } from '@prisma/client';
import { RegisterService } from './register.service';
import { RedisTtl } from '../../redis/redis.keys';
import { normalizePhone } from '../../common/validation/phone.schema';

jest.mock('argon2', () => ({
  argon2id: 2,
  hash: jest.fn(),
  verify: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const argon2 = require('argon2') as { hash: jest.Mock };

/**
 * Registration is two steps with a Redis record in between, and the whole
 * point of that shape is identity/invariants.md #11: no `user` row exists
 * until the phone is verified. These tests hold that line — nothing may
 * create a user before `verify-phone`, an expired pending record must not be
 * resurrectable, and a duplicate must be refused at both ends without the
 * response saying which column collided.
 */

// What a user types, and what the platform stores. The second is derived, not
// re-typed: the canonical form is `phone.schema`'s to decide (E.164 —
// ADR-0018), and every assertion below is about the *pending record following
// the normalization*, not about which spelling won.
const TYPED_PHONE = '09123456789';
const PHONE = normalizePhone(TYPED_PHONE);
const PENDING_KEY = `register:pending:${PHONE}`;

type Harness = ReturnType<typeof harness>;

function harness() {
  const prisma = {
    tenant: { findFirst: jest.fn().mockResolvedValue({ id: 'tenant-1' }) },
    role: { findFirst: jest.fn().mockResolvedValue({ id: 'role-user' }) },
    user: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'user-1' }),
    },
  };
  const redis = {
    setJson: jest.fn().mockResolvedValue(undefined),
    getJson: jest.fn(),
    del: jest.fn().mockResolvedValue(undefined),
  };
  const otpService = {
    issueOtp: jest.fn().mockResolvedValue(undefined),
    verifyOtp: jest.fn().mockResolvedValue(true),
  };
  const channels = {
    defaultChannel: jest.fn().mockReturnValue(OtpChannel.sms),
    requiresLink: jest.fn().mockReturnValue(false),
    assertUsable: jest.fn(),
  };
  const botLinks = {
    hasVerifiedLink: jest.fn().mockResolvedValue(true),
    startLink: jest.fn().mockResolvedValue({ linkUrl: 'https://t.me/bot?start=tok' }),
    promoteProvenChat: jest.fn().mockResolvedValue(undefined),
  };

  const service = new RegisterService(
    prisma as never,
    redis as never,
    otpService as never,
    channels as never,
    botLinks as never,
  );

  return { service, prisma, redis, otpService, channels, botLinks };
}

const input = (over: Record<string, unknown> = {}) => ({
  fullName: 'Behnam Tabrizi',
  username: 'behnam',
  phoneNumber: PHONE,
  password: 'Str0ng!Secret',
  ...over,
});

const register = (h: Harness, over: Record<string, unknown> = {}) =>
  h.service.register(input(over) as never, '1.2.3.4', 'fa');

describe('RegisterService.register — the pending record', () => {
  let h: Harness;

  beforeEach(() => {
    jest.clearAllMocks();
    h = harness();
    argon2.hash.mockResolvedValue('argon2-hash');
  });

  it('stashes the registration in Redis and creates no user row', async () => {
    const res = await register(h);

    expect(res).toEqual({
      ok: true,
      msg: 'register.success',
      data: { phoneNumber: PHONE, requiresPhoneVerification: true },
    });
    expect(h.redis.setJson).toHaveBeenCalledWith(
      PENDING_KEY,
      {
        fullName: 'Behnam Tabrizi',
        username: 'behnam',
        phoneNumber: PHONE,
        passwordHash: 'argon2-hash',
        tenantId: 'tenant-1',
        roleId: 'role-user',
      },
      RedisTtl.registerPending,
    );
    expect(h.prisma.user.create).not.toHaveBeenCalled();
  });

  it('gives the pending record a bounded lifetime', async () => {
    await register(h);
    const ttl = h.redis.setJson.mock.calls[0][2];
    expect(typeof ttl).toBe('number');
    expect(ttl).toBeGreaterThan(0);
  });

  it('never stores the plaintext password', async () => {
    await register(h);
    expect(JSON.stringify(h.redis.setJson.mock.calls[0][1])).not.toContain(
      'Str0ng!Secret',
    );
  });

  it.each([
    ['+989123456789'],
    ['00989123456789'],
    ['09123456789'],
  ])('keys the pending record by the normalized form of %s', async (raw) => {
    await register(h, { phoneNumber: raw });
    expect(h.redis.setJson.mock.calls[0][0]).toBe(PENDING_KEY);
    expect(h.otpService.issueOtp.mock.calls[0][0]).toBe(PHONE);
  });

  it('lets a re-submit overwrite the previous pending record for the same phone', async () => {
    await register(h);
    await register(h, { fullName: 'Behnam T' });

    expect(h.redis.setJson).toHaveBeenCalledTimes(2);
    expect(h.redis.setJson.mock.calls[0][0]).toBe(
      h.redis.setJson.mock.calls[1][0],
    );
    expect(h.redis.setJson.mock.calls[1][1]).toMatchObject({
      fullName: 'Behnam T',
    });
  });

  it('sends the verification code for the register purpose', async () => {
    await register(h);

    expect(h.otpService.issueOtp).toHaveBeenCalledWith(
      PHONE,
      OtpPurpose.register_phone_verify,
      OtpChannel.sms,
      '1.2.3.4',
      'fa',
    );
  });

  it('honours a channel named in the request over the environment default', async () => {
    await register(h, { channel: OtpChannel.bale });
    expect(h.otpService.issueOtp.mock.calls[0][2]).toBe(OtpChannel.bale);
    expect(h.channels.defaultChannel).not.toHaveBeenCalled();
  });
});

describe('RegisterService.register — refusals', () => {
  let h: Harness;

  beforeEach(() => {
    jest.clearAllMocks();
    h = harness();
    argon2.hash.mockResolvedValue('argon2-hash');
  });

  it.each([
    ['the username', 'xbehnamx!2026'],
    ['the phone number', 'a09123456789B!'],
  ])('refuses a password containing %s, before anything is written', async (
    _label,
    password,
  ) => {
    const res = await register(h, { password });

    expect(res).toEqual({
      ok: false,
      msg: 'password.containsProfileData',
      error: null,
    });
    expect(argon2.hash).not.toHaveBeenCalled();
    expect(h.redis.setJson).not.toHaveBeenCalled();
    expect(h.prisma.tenant.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    ['tenant', 'tenant'],
    ['role', 'role'],
  ])('refuses when the default %s is missing', async (_label, missing) => {
    (h.prisma as never as Record<string, { findFirst: jest.Mock }>)[
      missing
    ].findFirst.mockResolvedValue(null);

    expect(await register(h)).toEqual({
      ok: false,
      msg: 'register.defaultRoleMissing',
      error: null,
    });
    expect(h.redis.setJson).not.toHaveBeenCalled();
  });

  it('refuses a username or phone already claimed, without saying which', async () => {
    h.prisma.user.findFirst.mockResolvedValue({ id: 'existing' });

    const res = await register(h);

    expect(res).toEqual({
      ok: false,
      msg: 'register.duplicateUser',
      error: null,
    });
    expect(h.redis.setJson).not.toHaveBeenCalled();
    expect(h.otpService.issueOtp).not.toHaveBeenCalled();
  });

  it('checks the claim against the normalized phone, not the raw input', async () => {
    await register(h, { phoneNumber: '+989123456789' });

    expect(h.prisma.user.findFirst.mock.calls[0][0].where).toEqual({
      OR: [{ username: 'behnam' }, { phoneNumber: PHONE }],
    });
  });

  it('refuses when the environment offers no channel at all', async () => {
    h.channels.defaultChannel.mockReturnValue(null);

    expect(await register(h)).toEqual({
      ok: false,
      msg: 'otp.noChannelAvailable',
      error: null,
    });
    expect(h.otpService.issueOtp).not.toHaveBeenCalled();
  });
});

describe('RegisterService.register — messenger channels', () => {
  let h: Harness;

  beforeEach(() => {
    jest.clearAllMocks();
    h = harness();
    argon2.hash.mockResolvedValue('argon2-hash');
    h.channels.requiresLink.mockReturnValue(true);
    h.channels.defaultChannel.mockReturnValue(OtpChannel.telegram);
  });

  it('answers with a bot link, and no code, when the messenger is not linked yet', async () => {
    h.botLinks.hasVerifiedLink.mockResolvedValue(false);

    const res = await register(h);

    expect(res).toEqual({
      ok: true,
      msg: 'auth.botLinkRequired',
      data: {
        phoneNumber: PHONE,
        requiresPhoneVerification: true,
        linkUrl: 'https://t.me/bot?start=tok',
      },
    });
    expect(h.botLinks.startLink).toHaveBeenCalledWith({
      platform: OtpChannel.telegram,
      phoneNumber: PHONE,
      purpose: OtpPurpose.register_phone_verify,
      lang: 'fa',
      ip: '1.2.3.4',
    });
    expect(h.otpService.issueOtp).not.toHaveBeenCalled();
  });

  it('still stashes the pending record so the link can complete the signup', async () => {
    h.botLinks.hasVerifiedLink.mockResolvedValue(false);

    await register(h);

    expect(h.redis.setJson).toHaveBeenCalledWith(
      PENDING_KEY,
      expect.objectContaining({ phoneNumber: PHONE }),
      RedisTtl.registerPending,
    );
  });

  it('sends the code directly when the messenger is already linked', async () => {
    h.botLinks.hasVerifiedLink.mockResolvedValue(true);

    await register(h);

    expect(h.botLinks.startLink).not.toHaveBeenCalled();
    expect(h.otpService.issueOtp).toHaveBeenCalledWith(
      PHONE,
      OtpPurpose.register_phone_verify,
      OtpChannel.telegram,
      '1.2.3.4',
      'fa',
    );
  });

  it('checks the channel is usable before handing out a link the bot cannot honour', async () => {
    h.botLinks.hasVerifiedLink.mockResolvedValue(false);
    await register(h);
    expect(h.channels.assertUsable).toHaveBeenCalledWith(OtpChannel.telegram);
  });
});

describe('RegisterService.verifyPhone', () => {
  let h: Harness;

  const pending = {
    fullName: 'Behnam Tabrizi',
    username: 'behnam',
    phoneNumber: PHONE,
    passwordHash: 'argon2-hash',
    tenantId: 'tenant-1',
    roleId: 'role-user',
  };

  const verify = (over: Record<string, unknown> = {}) =>
    h.service.verifyPhone({
      phoneNumber: PHONE,
      otpCode: '123456',
      ...over,
    } as never);

  beforeEach(() => {
    jest.clearAllMocks();
    h = harness();
    h.redis.getJson.mockResolvedValue(pending);
  });

  it('promotes the pending record into a verified, active user', async () => {
    const res = await verify();

    expect(h.otpService.verifyOtp).toHaveBeenCalledWith(
      PHONE,
      OtpPurpose.register_phone_verify,
      '123456',
    );
    expect(h.prisma.user.create.mock.calls[0][0].data).toMatchObject({
      fullName: 'Behnam Tabrizi',
      username: 'behnam',
      phoneNumber: PHONE,
      passwordHash: 'argon2-hash',
      tenantId: 'tenant-1',
      roleId: 'role-user',
      status: 'active',
    });
    expect(h.prisma.user.create.mock.calls[0][0].data.phoneVerifiedAt).toBeInstanceOf(
      Date,
    );
    expect(res).toEqual({
      ok: true,
      msg: 'register.phoneVerified',
      data: { userId: 'user-1', phoneVerified: true },
    });
  });

  it('consumes the pending record so the same OTP cannot be replayed', async () => {
    await verify();
    expect(h.redis.del).toHaveBeenCalledWith(PENDING_KEY);
  });

  it('attaches the chat that proved the number to the new account', async () => {
    await verify();
    expect(h.botLinks.promoteProvenChat).toHaveBeenCalledWith('user-1', PHONE);
  });

  it('creates nothing when the code is wrong', async () => {
    h.otpService.verifyOtp.mockResolvedValue(false);

    expect(await verify()).toEqual({ ok: false, msg: 'otp.invalid', error: null });
    expect(h.redis.getJson).not.toHaveBeenCalled();
    expect(h.prisma.user.create).not.toHaveBeenCalled();
  });

  it('refuses a correct code once the pending record has expired', async () => {
    h.redis.getJson.mockResolvedValue(null);

    expect(await verify()).toEqual({
      ok: false,
      msg: 'register.pending.expired',
      error: null,
    });
    expect(h.prisma.user.create).not.toHaveBeenCalled();
    expect(h.redis.del).not.toHaveBeenCalled();
  });

  it('reads the pending record under the normalized phone key', async () => {
    await h.service.verifyPhone({
      phoneNumber: '+989123456789',
      otpCode: '123456',
    } as never);

    expect(h.redis.getJson).toHaveBeenCalledWith(PENDING_KEY);
  });

  it('turns a unique-constraint race into duplicateUser without leaking the column', async () => {
    h.prisma.user.create.mockRejectedValue(
      Object.assign(new Error('unique'), {
        code: 'P2002',
        meta: { target: ['phoneNumber'] },
      }),
    );

    const res = await verify();

    expect(res).toEqual({
      ok: false,
      msg: 'register.duplicateUser',
      error: null,
    });
    expect(JSON.stringify(res)).not.toContain('phoneNumber');
    expect(h.redis.del).not.toHaveBeenCalled();
    expect(h.botLinks.promoteProvenChat).not.toHaveBeenCalled();
  });

  it('does not swallow an unexpected database error as a duplicate', async () => {
    h.prisma.user.create.mockRejectedValue(
      Object.assign(new Error('connection reset'), { code: 'P1001' }),
    );

    // safeExecute turns anything that is not an HttpException into an opaque
    // 500 rather than a business answer — the caller must not read it as
    // "this username is taken".
    await expect(verify()).rejects.toMatchObject({ status: 500 });
  });
});
