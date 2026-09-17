import { BadRequestException } from '@nestjs/common';
import { OtpChannel, OtpPurpose } from '@prisma/client';
import { OtpChannelRegistry } from './otp-channels.service';

/**
 * `OTP_ALLOWED_CHANNELS` is an operator switch, and getting it wrong is not
 * loud: the wrong combination either offers a channel nothing can deliver on,
 * or silently drops the only one that works. The two gates (allowed, and its
 * sender configured) are therefore tested as a matrix of environments rather
 * than one happy path.
 */

type Env = Record<string, unknown>;

const sender = (
  channel: OtpChannel,
  configured: boolean,
  requiresLink: boolean,
  onlyFor?: OtpPurpose,
) => ({
  channel,
  isConfigured: () => configured,
  requiresLinkedAccount: requiresLink,
  onlyFor,
  send: vi.fn(),
});

function registry(
  env: Env,
  configured: Partial<Record<OtpChannel, boolean>> = {},
) {
  const config = {
    get: vi.fn((key: string, fallback?: unknown) =>
      key in env ? env[key] : fallback,
    ),
  };
  // A set, the way the service is wired (`OTP_SENDERS`): the registry keys it
  // by each sender's own `channel`, so this list can grow or shrink without
  // the call changing shape.
  return new OtpChannelRegistry(config as never, [
    sender(OtpChannel.sms, configured.sms ?? true, false),
    sender(OtpChannel.bale, configured.bale ?? true, true),
    sender(OtpChannel.telegram, configured.telegram ?? true, true),
    sender(OtpChannel.email, configured.email ?? true, false, OtpPurpose.email_verify),
  ] as never);
}

describe('OtpChannelRegistry — reading OTP_ALLOWED_CHANNELS', () => {
  it('defaults to SMS only when the variable is unset', async () => {
    const r = registry({});

    expect(r.isAllowed(OtpChannel.sms)).toBe(true);
    expect(r.isAllowed(OtpChannel.telegram)).toBe(false);
    expect(r.isAllowed(OtpChannel.bale)).toBe(false);
    expect(await r.available()).toEqual([OtpChannel.sms]);
  });

  it.each([
    ['a comma-separated string', 'sms,telegram'],
    ['an already-parsed array', ['sms', 'telegram']],
    ['a string with padding', ' sms , telegram '],
  ])('accepts %s', async (_label, raw) => {
    const r = registry({ OTP_ALLOWED_CHANNELS: raw });

    expect(await r.available()).toEqual([OtpChannel.sms, OtpChannel.telegram]);
  });

  it('keeps the operator ordering rather than a hardcoded one', async () => {
    const r = registry({ OTP_ALLOWED_CHANNELS: 'bale,telegram,sms' });

    expect(await r.available()).toEqual([
      OtpChannel.bale,
      OtpChannel.telegram,
      OtpChannel.sms,
    ]);
    expect(await r.defaultChannel()).toBe(OtpChannel.bale);
  });

  it('drops a name that is not a channel and keeps the rest', async () => {
    const warn = vi
      .spyOn(require('@nestjs/common').Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    const r = registry({ OTP_ALLOWED_CHANNELS: 'sms,whatsapp,telegram' });

    expect(await r.available()).toEqual([OtpChannel.sms, OtpChannel.telegram]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('whatsapp'));
    warn.mockRestore();
  });

  it('is empty, not SMS, when the variable lists nothing usable', async () => {
    const r = registry({ OTP_ALLOWED_CHANNELS: 'whatsapp' });

    expect(await r.available()).toEqual([]);
    expect(await r.defaultChannel()).toBeNull();
  });

  it('allows a messengers-only deployment with no SMS at all', async () => {
    const r = registry({ OTP_ALLOWED_CHANNELS: 'telegram,bale' });

    expect(r.isAllowed(OtpChannel.sms)).toBe(false);
    expect(await r.isAvailable(OtpChannel.sms)).toBe(false);
    expect(await r.defaultChannel()).toBe(OtpChannel.telegram);
  });
});

describe('OtpChannelRegistry — the second gate: a configured sender', () => {
  it('does not offer an allowed channel whose sender is unconfigured', async () => {
    const r = registry(
      { OTP_ALLOWED_CHANNELS: 'sms,telegram' },
      { sms: false },
    );

    expect(r.isAllowed(OtpChannel.sms)).toBe(true);
    expect(await r.isAvailable(OtpChannel.sms)).toBe(false);
    expect(await r.available()).toEqual([OtpChannel.telegram]);
    expect((await r.describe()).map((d) => d.channel)).toEqual([OtpChannel.telegram]);
  });

  it('skips the unconfigured first choice when picking a default', async () => {
    const r = registry(
      { OTP_ALLOWED_CHANNELS: 'sms,bale' },
      { sms: false },
    );

    expect(await r.defaultChannel()).toBe(OtpChannel.bale);
  });

  it('has no default when every allowed channel is unconfigured', async () => {
    const r = registry(
      { OTP_ALLOWED_CHANNELS: 'sms,telegram' },
      { sms: false, telegram: false },
    );

    expect(await r.defaultChannel()).toBeNull();
    expect(await r.describe()).toEqual([]);
  });

  it.each([
    ['OTP_DELIVERY_MODE=console', { OTP_DELIVERY_MODE: 'console' }],
    ['OTP_DEV_CONSOLE_LOG=true', { OTP_DEV_CONSOLE_LOG: true }],
  ])('waives the sender gate under %s', async (_label, extra) => {
    const r = registry(
      { OTP_ALLOWED_CHANNELS: 'sms,telegram', ...extra },
      { sms: false, telegram: false },
    );

    expect(r.isConsoleOnly()).toBe(true);
    expect(await r.available()).toEqual([OtpChannel.sms, OtpChannel.telegram]);
  });

  it('never waives the allowed gate, even in console mode', async () => {
    const r = registry({
      OTP_ALLOWED_CHANNELS: 'sms',
      OTP_DELIVERY_MODE: 'console',
    });

    expect(await r.isAvailable(OtpChannel.telegram)).toBe(false);
    await expect(r.assertUsable(OtpChannel.telegram)).rejects.toThrow(
      'otp.channelNotAllowed',
    );
  });

  it('treats live delivery as the default mode', async () => {
    expect(registry({}).isConsoleOnly()).toBe(false);
  });
});

describe('OtpChannelRegistry — describe() and requiresLink', () => {
  it('tells the client which channels need a linked messenger', async () => {
    const r = registry({ OTP_ALLOWED_CHANNELS: 'sms,telegram,bale' });

    expect(await r.describe()).toEqual([
      { channel: OtpChannel.sms, requiresLink: false },
      { channel: OtpChannel.telegram, requiresLink: true },
      { channel: OtpChannel.bale, requiresLink: true },
    ]);
  });

  it('reports no link requirement for a channel it does not know', async () => {
    const r = registry({});
    expect(r.requiresLink('whatsapp' as OtpChannel)).toBe(false);
  });
});

describe('OtpChannelRegistry.assertUsable — one key per reason', () => {
  it('says channelNotSupported for a name with no sender behind it', async () => {
    await expect(
      registry({}).assertUsable('whatsapp' as OtpChannel),
    ).rejects.toThrow(new BadRequestException('otp.channelNotSupported'));
  });

  it('says channelNotAllowed for a real channel the operator switched off', async () => {
    const r = registry({ OTP_ALLOWED_CHANNELS: 'sms' });

    await expect(r.assertUsable(OtpChannel.bale)).rejects.toThrow(
      new BadRequestException('otp.channelNotAllowed'),
    );
  });

  it('says channelNotConfigured for an allowed channel missing its credentials', async () => {
    const r = registry({ OTP_ALLOWED_CHANNELS: 'sms' }, { sms: false });

    await expect(r.assertUsable(OtpChannel.sms)).rejects.toThrow(
      new BadRequestException('otp.channelNotConfigured'),
    );
  });

  it('returns the sender when both gates pass', async () => {
    const r = registry({ OTP_ALLOWED_CHANNELS: 'telegram' });

    expect(await r.assertUsable(OtpChannel.telegram)).toBe(
      r.sender(OtpChannel.telegram),
    );
  });
});

/**
 * `email` is a channel for one purpose only (F-035-g, D-39): it proves a user
 * reads an address, and nothing else. A login code mailed to an address would
 * turn the email into a second, weaker password; an `email_verify` code sent
 * by SMS would prove nothing about the address. The pairing is the registry's
 * to refuse, because it is the one place every issue and every send asks.
 */
describe('OtpChannelRegistry — a channel reserved to one purpose', () => {
  it('is never offered as a login channel, even when the operator lists it', async () => {
    const r = registry({ OTP_ALLOWED_CHANNELS: 'sms,email' });

    expect(r.isAllowed(OtpChannel.email)).toBe(false);
    expect(await r.available()).toEqual([OtpChannel.sms]);
  });

  it('refuses email for any purpose but email_verify', async () => {
    const r = registry({});

    await expect(r.assertUsable(OtpChannel.email)).rejects.toThrow(
      new BadRequestException('otp.channelNotSupported'),
    );
    await expect(
      r.assertUsable(OtpChannel.email, OtpPurpose.login),
    ).rejects.toThrow(new BadRequestException('otp.channelNotSupported'));
  });

  it('refuses email_verify on any channel but email', async () => {
    const r = registry({ OTP_ALLOWED_CHANNELS: 'sms' });

    await expect(
      r.assertUsable(OtpChannel.sms, OtpPurpose.email_verify),
    ).rejects.toThrow(new BadRequestException('otp.channelNotSupported'));
  });

  it('gates email_verify on the mail driver being configured, not on OTP_ALLOWED_CHANNELS', async () => {
    const r = registry({ OTP_ALLOWED_CHANNELS: 'sms' });
    expect(
      await r.assertUsable(OtpChannel.email, OtpPurpose.email_verify),
    ).toBe(r.sender(OtpChannel.email));

    const off = registry({ OTP_ALLOWED_CHANNELS: 'sms' }, { email: false });
    await expect(
      off.assertUsable(OtpChannel.email, OtpPurpose.email_verify),
    ).rejects.toThrow(new BadRequestException('otp.channelNotConfigured'));
  });
});

/**
 * Whether SMS can reach someone depends on who they are under a reseller
 * (F-018-b, D-41): the owner is on the platform's line, everyone else on the
 * reseller's own or on none. The registry does not decide that; it hands the
 * sender the destination on every question that has one, and none to the
 * anonymous channel list.
 */
describe('OtpChannelRegistry — the destination reaches the sender (F-018-b)', () => {
  const OWNER = '+989120000002';

  function ownerOnlySms() {
    const sms = { ...sender(OtpChannel.sms, false, false), isConfigured: vi.fn((to?: string) => to === OWNER) };
    const r = new OtpChannelRegistry(
      { get: vi.fn((key: string, fallback?: unknown) => (key === 'OTP_ALLOWED_CHANNELS' ? 'sms,telegram' : fallback)) } as never,
      [sms, sender(OtpChannel.telegram, true, true)] as never,
    );
    return { r, sms };
  }

  it('leaves SMS out of the anonymous list and the anonymous default', async () => {
    const { r, sms } = ownerOnlySms();

    expect((await r.describe()).map((d) => d.channel)).toEqual([OtpChannel.telegram]);
    expect(await r.defaultChannel()).toBe(OtpChannel.telegram);
    expect(sms.isConfigured).toHaveBeenCalledWith(undefined);
  });

  it('offers and accepts SMS for the destination the sender can reach, and refuses it for anyone else', async () => {
    const { r } = ownerOnlySms();

    expect(await r.isAvailable(OtpChannel.sms, OWNER)).toBe(true);
    expect(await r.defaultChannel(OWNER)).toBe(OtpChannel.sms);
    expect(await r.assertUsable(OtpChannel.sms, OtpPurpose.login, OWNER)).toBe(r.sender(OtpChannel.sms));
    await expect(r.assertUsable(OtpChannel.sms, OtpPurpose.login, '+989121112233')).rejects.toThrow(
      new BadRequestException('otp.channelNotConfigured'),
    );
  });
});
