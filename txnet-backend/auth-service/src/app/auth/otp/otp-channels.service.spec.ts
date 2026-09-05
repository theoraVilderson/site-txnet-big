import { BadRequestException } from '@nestjs/common';
import { OtpChannel } from '@prisma/client';
import { OtpChannelRegistry } from './otp-channels.service';

/**
 * `OTP_ALLOWED_CHANNELS` is an operator switch, and getting it wrong is not
 * loud: the wrong combination either offers a channel nothing can deliver on,
 * or silently drops the only one that works. The two gates (allowed, and its
 * sender configured) are therefore tested as a matrix of environments rather
 * than one happy path.
 */

type Env = Record<string, unknown>;

const sender = (channel: OtpChannel, configured: boolean, requiresLink: boolean) => ({
  channel,
  isConfigured: () => configured,
  requiresLinkedAccount: requiresLink,
  send: jest.fn(),
});

function registry(
  env: Env,
  configured: Partial<Record<OtpChannel, boolean>> = {},
) {
  const config = {
    get: jest.fn((key: string, fallback?: unknown) =>
      key in env ? env[key] : fallback,
    ),
  };
  return new OtpChannelRegistry(
    config as never,
    sender(OtpChannel.sms, configured.sms ?? true, false) as never,
    sender(OtpChannel.bale, configured.bale ?? true, true) as never,
    sender(OtpChannel.telegram, configured.telegram ?? true, true) as never,
  );
}

describe('OtpChannelRegistry — reading OTP_ALLOWED_CHANNELS', () => {
  it('defaults to SMS only when the variable is unset', () => {
    const r = registry({});

    expect(r.isAllowed(OtpChannel.sms)).toBe(true);
    expect(r.isAllowed(OtpChannel.telegram)).toBe(false);
    expect(r.isAllowed(OtpChannel.bale)).toBe(false);
    expect(r.available()).toEqual([OtpChannel.sms]);
  });

  it.each([
    ['a comma-separated string', 'sms,telegram'],
    ['an already-parsed array', ['sms', 'telegram']],
    ['a string with padding', ' sms , telegram '],
  ])('accepts %s', (_label, raw) => {
    const r = registry({ OTP_ALLOWED_CHANNELS: raw });

    expect(r.available()).toEqual([OtpChannel.sms, OtpChannel.telegram]);
  });

  it('keeps the operator ordering rather than a hardcoded one', () => {
    const r = registry({ OTP_ALLOWED_CHANNELS: 'bale,telegram,sms' });

    expect(r.available()).toEqual([
      OtpChannel.bale,
      OtpChannel.telegram,
      OtpChannel.sms,
    ]);
    expect(r.defaultChannel()).toBe(OtpChannel.bale);
  });

  it('drops a name that is not a channel and keeps the rest', () => {
    const warn = jest
      .spyOn(require('@nestjs/common').Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    const r = registry({ OTP_ALLOWED_CHANNELS: 'sms,whatsapp,telegram' });

    expect(r.available()).toEqual([OtpChannel.sms, OtpChannel.telegram]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('whatsapp'));
    warn.mockRestore();
  });

  it('is empty, not SMS, when the variable lists nothing usable', () => {
    const r = registry({ OTP_ALLOWED_CHANNELS: 'whatsapp' });

    expect(r.available()).toEqual([]);
    expect(r.defaultChannel()).toBeNull();
  });

  it('allows a messengers-only deployment with no SMS at all', () => {
    const r = registry({ OTP_ALLOWED_CHANNELS: 'telegram,bale' });

    expect(r.isAllowed(OtpChannel.sms)).toBe(false);
    expect(r.isAvailable(OtpChannel.sms)).toBe(false);
    expect(r.defaultChannel()).toBe(OtpChannel.telegram);
  });
});

describe('OtpChannelRegistry — the second gate: a configured sender', () => {
  it('does not offer an allowed channel whose sender is unconfigured', () => {
    const r = registry(
      { OTP_ALLOWED_CHANNELS: 'sms,telegram' },
      { sms: false },
    );

    expect(r.isAllowed(OtpChannel.sms)).toBe(true);
    expect(r.isAvailable(OtpChannel.sms)).toBe(false);
    expect(r.available()).toEqual([OtpChannel.telegram]);
    expect(r.describe().map((d) => d.channel)).toEqual([OtpChannel.telegram]);
  });

  it('skips the unconfigured first choice when picking a default', () => {
    const r = registry(
      { OTP_ALLOWED_CHANNELS: 'sms,bale' },
      { sms: false },
    );

    expect(r.defaultChannel()).toBe(OtpChannel.bale);
  });

  it('has no default when every allowed channel is unconfigured', () => {
    const r = registry(
      { OTP_ALLOWED_CHANNELS: 'sms,telegram' },
      { sms: false, telegram: false },
    );

    expect(r.defaultChannel()).toBeNull();
    expect(r.describe()).toEqual([]);
  });

  it.each([
    ['OTP_DELIVERY_MODE=console', { OTP_DELIVERY_MODE: 'console' }],
    ['OTP_DEV_CONSOLE_LOG=true', { OTP_DEV_CONSOLE_LOG: true }],
  ])('waives the sender gate under %s', (_label, extra) => {
    const r = registry(
      { OTP_ALLOWED_CHANNELS: 'sms,telegram', ...extra },
      { sms: false, telegram: false },
    );

    expect(r.isConsoleOnly()).toBe(true);
    expect(r.available()).toEqual([OtpChannel.sms, OtpChannel.telegram]);
  });

  it('never waives the allowed gate, even in console mode', () => {
    const r = registry({
      OTP_ALLOWED_CHANNELS: 'sms',
      OTP_DELIVERY_MODE: 'console',
    });

    expect(r.isAvailable(OtpChannel.telegram)).toBe(false);
    expect(() => r.assertUsable(OtpChannel.telegram)).toThrow(
      'otp.channelNotAllowed',
    );
  });

  it('treats live delivery as the default mode', () => {
    expect(registry({}).isConsoleOnly()).toBe(false);
  });
});

describe('OtpChannelRegistry — describe() and requiresLink', () => {
  it('tells the client which channels need a linked messenger', () => {
    const r = registry({ OTP_ALLOWED_CHANNELS: 'sms,telegram,bale' });

    expect(r.describe()).toEqual([
      { channel: OtpChannel.sms, requiresLink: false },
      { channel: OtpChannel.telegram, requiresLink: true },
      { channel: OtpChannel.bale, requiresLink: true },
    ]);
  });

  it('reports no link requirement for a channel it does not know', () => {
    const r = registry({});
    expect(r.requiresLink('whatsapp' as OtpChannel)).toBe(false);
  });
});

describe('OtpChannelRegistry.assertUsable — one key per reason', () => {
  it('says channelNotSupported for a name with no sender behind it', () => {
    expect(() => registry({}).assertUsable('whatsapp' as OtpChannel)).toThrow(
      new BadRequestException('otp.channelNotSupported'),
    );
  });

  it('says channelNotAllowed for a real channel the operator switched off', () => {
    const r = registry({ OTP_ALLOWED_CHANNELS: 'sms' });

    expect(() => r.assertUsable(OtpChannel.bale)).toThrow(
      new BadRequestException('otp.channelNotAllowed'),
    );
  });

  it('says channelNotConfigured for an allowed channel missing its credentials', () => {
    const r = registry({ OTP_ALLOWED_CHANNELS: 'sms' }, { sms: false });

    expect(() => r.assertUsable(OtpChannel.sms)).toThrow(
      new BadRequestException('otp.channelNotConfigured'),
    );
  });

  it('returns the sender when both gates pass', () => {
    const r = registry({ OTP_ALLOWED_CHANNELS: 'telegram' });

    expect(r.assertUsable(OtpChannel.telegram)).toBe(
      r.sender(OtpChannel.telegram),
    );
  });
});
