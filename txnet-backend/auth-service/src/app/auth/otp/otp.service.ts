// src/app/auth/otp/otp.service.ts

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  HttpException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomInt } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisTtl } from '../../redis/redis.keys';
import { TenantContext } from '../../tenant-context/tenant-context';
import { OtpStore } from './otp.store';
import {
  OtpDeliveryStore,
  type OtpDeliveryHandles,
} from './otp-delivery.store';
import { OtpDeliveryPublisher } from './otp-delivery.publisher';
import {
  IOtpService,
  OtpChannel,
  OtpDeliveryRequest,
  OtpDeliveryResult,
  OtpPurpose,
} from './otp.interface';
import { OtpChannelRegistry } from './otp-channels.service';

/**
 * OTP service implementation using Redis as the source of truth.
 * The delivery channel (sms/bale/telegram) is chosen by the user or env;
 * it is not fixed. Which channels exist at all is `OtpChannelRegistry`'s
 * call — see `OTP_ALLOWED_CHANNELS`.
 *
 * **The send is not in the request (F-067-a).** `issueOtp` used to call
 * `sender.send` — an SMS or messenger HTTP round trip — inside `login` and
 * `register`, and inside the Redis lock it holds while doing so. A slow
 * provider therefore held a lock and a request on the process that also
 * answers `/auth/login`. It now publishes instead and answers 202; the send
 * happens on `deliverOtp`, which only the internal seam calls.
 *
 * **What is on which side of that line is decided by one invariant.** The row
 * that opened this asked for the draw, the hash and the Redis save to stay in
 * the request and the message to carry the key they were saved under — but
 * what is saved under that key is an argon2id hash, and a sender needs the
 * code. Every arrangement that keeps the draw here puts the plaintext at rest
 * somewhere, on the queue or in a second Redis entry, which invariant #2
 * forbids. So the draw moved instead: the code is created by whoever sends it,
 * lives in one process's memory, and is never written down except as its hash.
 *
 * What stays in the request is what protects the *system* rather than what
 * carries the code: the channel check (so an unusable channel is still a
 * synchronous refusal and not a 202 that silently never arrives), the
 * idempotency lock, and the cooldown.
 */
@Injectable()
export class OtpService implements IOtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    private readonly store: OtpStore,
    private readonly prisma: PrismaService,
    private readonly channels: OtpChannelRegistry,
    private readonly delivery: OtpDeliveryStore,
    private readonly publisher: OtpDeliveryPublisher,
  ) {}

  async issueOtp(
    phoneNumber: string,
    purpose: OtpPurpose,
    channel: OtpChannel,
    requestIp: string,
    lang: string,
    delivery: OtpDeliveryHandles,
  ): Promise<void> {
    // Allowed by env *and* actually configured, or this request stops here.
    // Checked again on the delivery side, because a tenant can turn a channel
    // off in between; checked here because only here can the answer be a 400.
    await this.channels.assertUsable(channel);

    // Distributed lock for idempotency
    if (!(await this.store.acquireLock(phoneNumber, purpose))) {
      throw new ConflictException('previous OTP request is still processing');
    }

    try {
      // Cooldown between two requests
      if (await this.store.isCoolingDown(phoneNumber, purpose)) {
        throw new HttpException(
          'please wait before requesting another code',
          429,
        );
      }

      // Dev/staging escape hatch: skip the real channel entirely and print
      // the code instead, so registration/login work without a configured
      // SMS/bale/telegram provider (`OTP_DELIVERY_MODE=console`) — and, since
      // F-067-a, without a broker either. Nothing is queued, so a dev machine
      // does not need RabbitMQ to log in.
      if (this.channels.isConsoleOnly()) {
        const code = await this.mint(phoneNumber, purpose, channel, requestIp);
        await this.store.startCooldown(phoneNumber, purpose);
        console.info(`[otp:${purpose}:${channel}] ${phoneNumber}: ${code}`);
        await this.delivery.mark(delivery.deliveryId, delivery.channelId, {
          state: 'sent',
        });
        return;
      }

      // Published **before** the cooldown is started, so a publish the broker
      // did not confirm leaves nothing behind: the caller gets a 503 and can
      // retry immediately, rather than being told to wait 60s for a code that
      // was never queued.
      await this.publisher.publishDelivery({
        tenantId: TenantContext.current('an OTP delivery').id,
        phoneNumber,
        purpose,
        channel,
        requestIp,
        lang,
        deliveryId: delivery.deliveryId,
        channelId: delivery.channelId,
      });
      await this.store.startCooldown(phoneNumber, purpose);
      await this.delivery.mark(delivery.deliveryId, delivery.channelId, {
        state: 'queued',
      });
    } finally {
      // Always release the lock
      await this.store.releaseLock(phoneNumber, purpose);
    }
  }

  /**
   * Draw a code and send it. The internal seam's half of `issueOtp`.
   *
   * **Safe to run twice**, which the at-least-once queue in front of it
   * requires (ADR-0027): a redelivery draws a *new* code and overwrites the
   * old one, exactly as pressing "resend" does. The user gets the newer code,
   * and invariant #10 still holds — one active code per (tenant, phone,
   * purpose) — because the second save replaces the first.
   *
   * A refusal the sender can state (`otp.telegramNotLinked`,
   * `otp.smsNotConfigured`) is recorded as `failed` and **not** rethrown:
   * redelivering it would fail identically, and the user has already been told
   * by the status they are reading. Anything else throws, so the message
   * dead-letters (F-067-d) and an operator sees it.
   */
  async deliverOtp(request: OtpDeliveryRequest): Promise<OtpDeliveryResult> {
    const { phoneNumber, purpose, channel, requestIp, lang, deliveryId, channelId } =
      request;
    const sender = await this.channels.assertUsable(channel);
    const code = await this.mint(phoneNumber, purpose, channel, requestIp);

    try {
      await sender.send(phoneNumber, code, purpose, lang);
    } catch (err) {
      const failureKey =
        err instanceof BadRequestException
          ? String(err.message)
          : 'otp.deliveryFailed';
      await this.delivery.mark(deliveryId, channelId, {
        state: 'failed',
        failureKey,
      });
      if (err instanceof BadRequestException) {
        this.logger.warn(
          `${channel} refused the ${purpose} code for delivery ${deliveryId}: ${failureKey}`,
        );
        return { delivered: false, failureKey };
      }
      throw err;
    }

    await this.delivery.mark(deliveryId, channelId, { state: 'sent' });
    return { delivered: true };
  }

  /**
   * Draw a six-digit code, store its hash, and write the audit row.
   *
   * The range is [100000, 1000000) so every draw really has six digits — the
   * API's zod schemas reject anything shorter, so a 5-digit draw could never
   * be verified.
   */
  private async mint(
    phoneNumber: string,
    purpose: OtpPurpose,
    channel: OtpChannel,
    requestIp: string,
  ): Promise<string> {
    const code = randomInt(100000, 1000000).toString();
    const codeHash = await argon2.hash(code, { type: argon2.argon2id });

    await this.store.save(phoneNumber, purpose, codeHash);

    // Persist audit record in PostgreSQL (best effort)
    await this.prisma.otpCode.create({
      data: {
        phoneNumber,
        codeHash,
        purpose,
        channel,
        requestIp,
        expiresAt: new Date(Date.now() + RedisTtl.otpCode * 1000),
      },
    });

    return code;
  }

  async verifyOtp(
    phoneNumber: string,
    purpose: OtpPurpose,
    inputCode: string,
  ): Promise<boolean> {
    const peek = await this.store.peekForVerification(phoneNumber, purpose);

    if (peek.status === 'missing') {
      throw new BadRequestException('otp expired or invalid');
    }
    if (peek.status === 'exhausted') {
      throw new HttpException('otp attempts exhausted', 429);
    }

    const isValid = await argon2.verify(peek.codeHash, inputCode);
    if (!isValid) {
      throw new BadRequestException('invalid otp');
    }

    await this.store.clear(phoneNumber, purpose);
    await this.prisma.otpCode.updateMany({
      where: { phoneNumber, purpose, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    return true;
  }
}
