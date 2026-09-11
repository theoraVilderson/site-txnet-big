import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { OtpService } from './otp.service';
import { OtpStore } from './otp.store';
import { OtpDeliveryStore } from './otp-delivery.store';
import { OtpDeliveryPublisher } from './otp-delivery.publisher';
import { OtpChannelRegistry } from './otp-channels.service';
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
describe('OtpService — delivery leaves the request path', () => {
  const sender = { send: jest.fn() };
  let store: jest.Mocked<Pick<OtpStore, 'acquireLock' | 'releaseLock' | 'isCoolingDown' | 'startCooldown' | 'save'>>;
  let delivery: { mark: jest.Mock; read: jest.Mock };
  let publisher: { publishDelivery: jest.Mock };
  let prisma: { otpCode: { create: jest.Mock } };
  let channels: { assertUsable: jest.Mock; isConsoleOnly: jest.Mock };
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
    jest.clearAllMocks();
    store = {
      acquireLock: jest.fn().mockResolvedValue(true),
      releaseLock: jest.fn().mockResolvedValue(undefined),
      isCoolingDown: jest.fn().mockResolvedValue(false),
      startCooldown: jest.fn().mockResolvedValue(undefined),
      save: jest.fn().mockResolvedValue(undefined),
    } as never;
    delivery = { mark: jest.fn().mockResolvedValue(undefined), read: jest.fn() };
    publisher = { publishDelivery: jest.fn().mockResolvedValue(undefined) };
    prisma = { otpCode: { create: jest.fn().mockResolvedValue({}) } };
    channels = {
      assertUsable: jest.fn().mockResolvedValue(sender),
      isConsoleOnly: jest.fn().mockReturnValue(false),
    };
    service = new OtpService(
      store as unknown as OtpStore,
      prisma as unknown as PrismaService,
      channels as unknown as OtpChannelRegistry,
      delivery as unknown as OtpDeliveryStore,
      publisher as unknown as OtpDeliveryPublisher,
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
    const log = jest.spyOn(console, 'info').mockImplementation(() => undefined);

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
});
