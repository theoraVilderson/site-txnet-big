// src/app/auth/otp/otp.service.ts

import {
  BadRequestException,
  ConflictException,
  Injectable,
  HttpException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomInt } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisTtl } from '../../redis/redis.keys';
import { OtpStore } from './otp.store';
import { IOtpService, OtpChannel, OtpPurpose } from './otp.interface';
import { IOtpSender } from './senders/otp-sender.interface';
import { SmsOtpSender } from './senders/sms.sender';
import { BaleOtpSender } from './senders/bale.sender';
import { TelegramOtpSender } from './senders/telegram.sender';

/**
 * OTP service implementation using Redis as the source of truth.
 * The delivery channel (sms/bale/telegram) is chosen by the user or env;
 * it is not fixed.
 */
@Injectable()
export class OtpService implements IOtpService {
  private readonly senders: Map<OtpChannel, IOtpSender>;

  constructor(
    private readonly store: OtpStore,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    smsSender: SmsOtpSender,
    baleSender: BaleOtpSender,
    telegramSender: TelegramOtpSender,
  ) {
    this.senders = new Map<OtpChannel, IOtpSender>([
      [OtpChannel.sms, smsSender],
      [OtpChannel.bale, baleSender],
      [OtpChannel.telegram, telegramSender],
    ]);
  }

  async issueOtp(
    phoneNumber: string,
    purpose: OtpPurpose,
    channel: OtpChannel,
    requestIp: string,
    lang: string,
  ): Promise<void> {
    // This channel must be allowed in the current environment
    const allowedChannels = this.config.get<string[]>('OTP_ALLOWED_CHANNELS', [
      'sms',
    ]);
    if (!allowedChannels.includes(channel)) {
      throw new BadRequestException('otp.channelNotAllowed');
    }

    const sender = this.senders.get(channel);
    if (!sender) {
      throw new BadRequestException('otp.channelNotSupported');
    }

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

      // Generate a secure 6-digit code
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

      // Actually deliver it through the channel the user picked, in the
      // request's resolved language.
      await sender.send(phoneNumber, code, purpose, lang);

      // Console log independent of the real channel, only when explicitly
      // enabled via env (useful for dev, regardless of which real channel
      // was selected).
      if (this.config.get<boolean>('OTP_DEV_CONSOLE_LOG', false)) {
        console.info(`[otp:${purpose}:${channel}] ${phoneNumber}: ${code}`);
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
