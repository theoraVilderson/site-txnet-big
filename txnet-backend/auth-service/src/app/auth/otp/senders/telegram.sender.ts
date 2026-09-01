import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { IOtpSender } from './otp-sender.interface';
import { OtpChannel, OtpPurpose } from '../otp.interface';
import { TelegramLikeBotClient } from './telegram-like-bot.client';
import { buildOtpChatMessage } from './otp-message.util';
import { LocaleService } from '../../../locale/locale.service';

@Injectable()
export class TelegramOtpSender implements IOtpSender {
  readonly channel = OtpChannel.telegram;
  private readonly logger = new Logger(TelegramOtpSender.name);
  private readonly client: TelegramLikeBotClient | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly localeService: LocaleService,
  ) {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    const apiBase = this.config.get<string>(
      'TELEGRAM_API_BASE',
      'https://api.telegram.org',
    );
    const timeoutMs = this.config.get<number>('OTP_BOT_HTTP_TIMEOUT_MS', 5000);

    // If the token isn't set (e.g. dev environment), leave the client as
    // null so we throw a clear error instead of crashing silently.
    this.client = token
      ? new TelegramLikeBotClient('telegram', apiBase, token, timeoutMs)
      : null;
  }

  async send(
    phoneNumber: string,
    code: string,
    purpose: OtpPurpose,
    lang: string,
  ): Promise<void> {
    if (!this.client) {
      this.logger.error('TELEGRAM_BOT_TOKEN is not configured');
      throw new BadRequestException('otp.telegramNotConfigured');
    }

    const user = await this.prisma.user.findUnique({
      where: { phoneNumber },
      select: { id: true },
    });
    if (!user) throw new BadRequestException('otp.userNotFound');

    const link = await this.prisma.linkedBotAccount.findFirst({
      where: { userId: user.id, platform: 'telegram' },
      select: { platformUserId: true },
    });
    if (!link) throw new BadRequestException('otp.telegramNotLinked');

    const ns = this.localeService.getNamespace(lang, 'otp');
    const text = buildOtpChatMessage(ns, code, purpose);
    await this.client.sendMessage(link.platformUserId, text);
  }
}
