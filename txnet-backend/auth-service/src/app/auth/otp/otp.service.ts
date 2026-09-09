// src/app/auth/otp/otp.service.ts

import {
  BadRequestException,
  ConflictException,
  Injectable,
  HttpException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomInt } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisTtl } from '../../redis/redis.keys';
import { OtpStore } from './otp.store';
import { IOtpService, OtpChannel, OtpPurpose } from './otp.interface';
import { OtpChannelRegistry } from './otp-channels.service';

/**
 * OTP service implementation using Redis as the source of truth.
 * The delivery channel (sms/bale/telegram) is chosen by the user or env;
 * it is not fixed. Which channels exist at all is `OtpChannelRegistry`'s
 * call — see `OTP_ALLOWED_CHANNELS`.
 */
@Injectable()
export class OtpService implements IOtpService {
  constructor(
    private readonly store: OtpStore,
    private readonly prisma: PrismaService,
    private readonly channels: OtpChannelRegistry,
  ) {}

  async issueOtp(
    phoneNumber: string,
    purpose: OtpPurpose,
    channel: OtpChannel,
    requestIp: string,
    lang: string,
  ): Promise<void> {
    // Allowed by env *and* actually configured, or this request stops here.
    const sender = await this.channels.assertUsable(channel);

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

      // Generate a secure 6-digit code. The range is [100000, 1000000) so
      // every draw really has six digits — the API's zod schemas reject
      // anything shorter, so a 5-digit draw could never be verified.
      const code = randomInt(100000, 1000000).toString();
      const codeHash = await argon2.hash(code, { type: argon2.argon2id });

      await this.store.save(phoneNumber, purpose, codeHash);
      await this.store.startCooldown(phoneNumber, purpose);

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

      // Dev/staging escape hatch: skip the real channel entirely and print
      // the code instead, so registration/login work without a configured
      // SMS/bale/telegram provider (`OTP_DELIVERY_MODE=console`).
      if (this.channels.isConsoleOnly()) {
        console.info(`[otp:${purpose}:${channel}] ${phoneNumber}: ${code}`);
      } else {
        // Actually deliver it through the channel the user picked, in the
        // request's resolved language.
        await sender.send(phoneNumber, code, purpose, lang);
      }
    } finally {
      // Always release the lock
      await this.store.releaseLock(phoneNumber, purpose);
    }
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
