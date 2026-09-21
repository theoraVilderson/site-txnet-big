import type { Mock, Mocked } from 'vitest';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { OtpService } from './otp.service';
import { OtpStore } from './otp.store';
import { OtpDeliveryStore } from './otp-delivery.store';
import { OtpDeliveryPublisher } from './otp-delivery.publisher';
import { OtpChannelRegistry } from './otp-channels.service';
import { RateLimiter } from '../../common/rate-limit/rate-limiter';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { OtpChannel, OtpPurpose } from './otp.interface';
import { runWithTenant } from '../../tenant-context/tenant-context';

const TENANT = { id: 'tenant-a', slug: 'reseller-a', via: 'domain' } as const;
const PHONE = '+989121234567';
const DELIVERY = 'a'.repeat(32);
const CHANNEL_ID = 'c'.repeat(32);
/** The handles a route mints and hands to `issueOtp` (F-067-j). */
const HANDLES = {
  deliveryId: DELIVERY,
  channelId: CHANNEL_ID,
  channelToken: 'd'.repeat(32),
};

/**
 * F-067-a — **the send is not in the request, and the code is not at rest.**
 *
 * Two rules are pinned here, and they are the two the row turns on:
 *
 * 1. `issueOtp` publishes. It draws nothing, hashes nothing and writes no
 *    `otp_code` row, because the code it would draw would then have to reach
 *    the sender somehow — and every route from here to there stores the
 *    plaintext (invariant #2). Whoever sends draws.
 * 2. The lock is released and the cooldown is *not* started when the publish
 *    fails, so a broker that refused the message does not also make the caller
 *    wait 60s before retrying it.
 */
// Each delivery test runs a real argon2id hash — the invariant is that what is
// stored *is* one — and argon2id is slow and memory-hard by design. Alone that
// is well inside 5s; beside the workspace's `tsc` it was not (timed out
// 2026-09-16), so these tests get a budget that says why.
vi.setConfig({ testTimeout: 30_000 });

describe('OtpService — delivery leaves the request path', () => {
  const sender = { send: vi.fn() };
  let store: Mocked<Pick<OtpStore, 'acquireLock' | 'releaseLock' | 'isCoolingDown' | 'startCooldown' | 'save'>>;
  let delivery: { mark: Mock; read: Mock };
  let publisher: { publishDelivery: Mock };
  let prisma: { otpCode: { create: Mock } };
  let channels: { assertUsable: Mock; isConsoleOnly: Mock };
  let limiter: { hit: Mock };
  let config: { get: Mock };
  let service: OtpService;

  const issue = () =>
    runWithTenant(TENANT, () =>
      service.issueOtp(
        PHONE,
        OtpPurpose.login,
        OtpChannel.sms,
        '203.0.113.9',
        'fa',
        HANDLES,
      ),
    );

  beforeEach(() => {
    vi.clearAllMocks();
    store = {
      acquireLock: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
      isCoolingDown: vi.fn().mockResolvedValue(false),
      startCooldown: vi.fn().mockResolvedValue(undefined),
      save: vi.fn().mockResolvedValue(undefined),
    } as never;
    delivery = { mark: vi.fn().mockResolvedValue(undefined), read: vi.fn() };
    publisher = { publishDelivery: vi.fn().mockResolvedValue(undefined) };
    prisma = { otpCode: { create: vi.fn().mockResolvedValue({}) } };
    channels = {
      assertUsable: vi.fn().mockResolvedValue(sender),
      isConsoleOnly: vi.fn().mockReturnValue(false),
    };
    limiter = {
      hit: vi.fn().mockResolvedValue({ allowed: true, current: 1, limit: 5 }),
    };
    config = { get: vi.fn().mockReturnValue(5) };
    service = new OtpService(
      store as unknown as OtpStore,
      prisma as unknown as PrismaService,
      channels as unknown as OtpChannelRegistry,
      delivery as unknown as OtpDeliveryStore,
      publisher as unknown as OtpDeliveryPublisher,
      limiter as unknown as RateLimiter,
      config as unknown as ConfigService,
    );
  });

  it('publishes the send instead of making it, and draws no code doing so', async () => {
    await issue();

    expect(publisher.publishDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT.id,
        phoneNumber: PHONE,
        purpose: OtpPurpose.login,
        channel: OtpChannel.sms,
        deliveryId: DELIVERY,
        channelId: CHANNEL_ID,
      }),
    );
    // The whole point: the message carries these eight fields and no ninth,
    // so there is nowhere on it for a code to be — asserted as the exact key
    // set rather than as the absence of one name, because a field added later
    // would pass the second check and fail this one.
    expect(Object.keys(publisher.publishDelivery.mock.calls[0][0]).sort()).toEqual([
      'channel',
      'channelId',
      'deliveryId',
      'lang',
      'phoneNumber',
      'purpose',
      'requestIp',
      'tenantId',
    ]);
    expect(sender.send).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
    expect(prisma.otpCode.create).not.toHaveBeenCalled();

    expect(store.startCooldown).toHaveBeenCalled();
    expect(store.releaseLock).toHaveBeenCalled();
    expect(delivery.mark).toHaveBeenCalledWith(DELIVERY, CHANNEL_ID, { state: 'queued' });
  });

  it('leaves no cooldown behind when the broker did not confirm', async () => {
    publisher.publishDelivery.mockRejectedValue(
      new ServiceUnavailableException('otp.deliveryUnavailable'),
    );

    await expect(issue()).rejects.toBeInstanceOf(ServiceUnavailableException);
    // The caller was told it did not happen, so it must be able to try again
    // at once — a cooldown here would answer 429 to the retry.
    expect(store.startCooldown).not.toHaveBeenCalled();
    expect(store.releaseLock).toHaveBeenCalled();
    expect(delivery.mark).not.toHaveBeenCalled();
  });

  it('still delivers inline in console mode, so a dev box needs no broker', async () => {
    channels.isConsoleOnly.mockReturnValue(true);
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await issue();

    expect(publisher.publishDelivery).not.toHaveBeenCalled();
    expect(store.save).toHaveBeenCalled();
    expect(prisma.otpCode.create).toHaveBeenCalled();
    expect(delivery.mark).toHaveBeenCalledWith(DELIVERY, CHANNEL_ID, { state: 'sent' });
    log.mockRestore();
  });

  describe('deliverOtp — the half that holds the code', () => {
    const request = {
      tenantId: TENANT.id,
      phoneNumber: PHONE,
      purpose: OtpPurpose.login,
      channel: OtpChannel.sms,
      requestIp: '203.0.113.9',
      lang: 'fa',
      deliveryId: DELIVERY,
      channelId: CHANNEL_ID,
    };

    it('draws, stores only the hash, sends, and records the result', async () => {
      const result = await runWithTenant(TENANT, () =>
        service.deliverOtp(request),
      );

      expect(result).toEqual({ delivered: true });
      const [, code] = sender.send.mock.calls[0];
      expect(code).toMatch(/^\d{6}$/);

      // Invariant #2: what is written down is an argon2id hash, never the code.
      const [, , stored] = store.save.mock.calls[0];
      expect(stored).toMatch(/^\$argon2id\$/);
      expect(stored).not.toContain(code);
      expect(prisma.otpCode.create.mock.calls[0][0].data.codeHash).toBe(stored);

      expect(delivery.mark).toHaveBeenCalledWith(DELIVERY, CHANNEL_ID, { state: 'sent' });
    });

    it('records a refusal the channel can state, and does not dead-letter it', async () => {
      sender.send.mockRejectedValue(
        new BadRequestException('otp.telegramNotLinked'),
      );

      const result = await runWithTenant(TENANT, () =>
        service.deliverOtp(request),
      );

      // Acked, because a redelivery would be refused identically — and the
      // user reads the reason off the delivery status.
      expect(result).toEqual({
        delivered: false,
        failureKey: 'otp.telegramNotLinked',
      });
      expect(delivery.mark).toHaveBeenCalledWith(DELIVERY, CHANNEL_ID, {
        state: 'failed',
        failureKey: 'otp.telegramNotLinked',
      });
    });

    it('rethrows anything else, so the message dead-letters', async () => {
      sender.send.mockRejectedValue(new Error('provider timed out'));

      await expect(
        runWithTenant(TENANT, () => service.deliverOtp(request)),
      ).rejects.toThrow('provider timed out');
      expect(delivery.mark).toHaveBeenCalledWith(DELIVERY, CHANNEL_ID, {
        state: 'failed',
        failureKey: 'otp.deliveryFailed',
      });
    });
  });

  /**
   * The cap the catalog has always asked for: **OTP request | phone number | 5
   * | 1 hour** (§2.6). Every limit in front of `issueOtp` counts whoever
   * *asked* — an IP, a signed-in caller, a bot chat — so each one is bought
   * again with a new address, a new account or a new messenger chat, and the
   * number on the receiving end pays for all of them at once. This counter is
   * the only one keyed on the **recipient**, which is what makes it the one an
   * attacker cannot buy more of.
   *
   * It sits with the cooldown rather than on the routes because the routes are
   * not the whole surface: login, register, forgot and the account-switch proof
   * all arrive here, and the bot reaches every one of them through the same
   * `auth-api`. One counter here covers what six decorators would have had to
   * agree about.
   */
  describe('the per-number ceiling (catalog 2.6)', () => {
    it('counts the number being sent to, not the caller asking', async () => {
      await issue();

      expect(limiter.hit).toHaveBeenCalledWith(
        `otp:phone:${PHONE}`,
        5,
        3600,
      );
    });

    it('refuses a number that has had its hour\'s worth, and sends nothing', async () => {
      limiter.hit.mockResolvedValue({ allowed: false, current: 6, limit: 5 });

      await expect(issue()).rejects.toMatchObject({ status: 429 });
      expect(publisher.publishDelivery).not.toHaveBeenCalled();
      expect(store.startCooldown).not.toHaveBeenCalled();
      // The lock is still handed back: a refusal is not a stuck request.
      expect(store.releaseLock).toHaveBeenCalled();
    });

    it('spends nothing when the channel itself is unusable', async () => {
      // Counted after the channel check, so a user whose messenger is not
      // linked does not burn their own number's hourly budget discovering it.
      channels.assertUsable.mockRejectedValue(new BadRequestException('otp.telegramNotLinked'));

      await expect(issue()).rejects.toBeInstanceOf(BadRequestException);
      expect(limiter.hit).not.toHaveBeenCalled();
    });

    it('is spent by console mode too, so dev counts what prod counts', async () => {
      channels.isConsoleOnly.mockReturnValue(true);
      const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);

      await issue();

      expect(limiter.hit).toHaveBeenCalled();
      log.mockRestore();
    });
  });

});
