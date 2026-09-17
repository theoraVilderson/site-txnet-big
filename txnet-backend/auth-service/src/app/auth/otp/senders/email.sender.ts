import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IOtpSender } from './otp-sender.interface';
import { OtpChannel, OtpPurpose } from '../otp.interface';
import { LocaleService } from '../../../locale/locale.service';
import { buildOtpEmail } from './otp-message.util';
import { BackendI18nKeys, MailProviderService } from '@txnet-backend/shared-core';

/**
 * Mails an `email_verify` code (F-035-g, D-39) over the platform's SMTP relay.
 *
 * Reserved to that one purpose (`onlyFor`), so it is never offered as a login
 * channel and needs no `OTP_ALLOWED_CHANNELS` entry: configured means
 * `SMTP_HOST` and `MAIL_FROM` are set. The relay is the platform's, not the
 * tenant's — whose sending domain a reseller's mail should use is F-112's
 * question, and a verification code does not have to wait for it.
 */
@Injectable()
export class EmailOtpSender implements IOtpSender {
  readonly channel = OtpChannel.email;
  readonly requiresLinkedAccount = false;
  readonly onlyFor = OtpPurpose.email_verify;
  private readonly logger = new Logger(EmailOtpSender.name);
  private readonly provider: MailProviderService | null;

  constructor(
    config: ConfigService,
    private readonly localeService: LocaleService,
  ) {
    const host = config.get<string>('SMTP_HOST');
    const from = config.get<string>('MAIL_FROM');
    this.provider =
      host && from
        ? new MailProviderService({
            host,
            port: Number(config.get<number>('SMTP_PORT', 587)),
            secure: config.get<string>('SMTP_SECURE', 'false') === 'true',
            user: config.get<string>('SMTP_USER'),
            pass: config.get<string>('SMTP_PASS'),
            from,
          })
        : null;
  }

  isConfigured(): boolean {
    return this.provider !== null;
  }

  async send(
    address: string,
    code: string,
    purpose: OtpPurpose,
    lang: string,
  ): Promise<void> {
    if (!this.provider) {
      this.logger.error('SMTP_HOST / MAIL_FROM is not configured');
      throw new BadRequestException(BackendI18nKeys.errors.otp.channelNotConfigured);
    }

    const ns = this.localeService.getNamespace(lang, 'notifications');
    const result = await this.provider.sendMail({
      to: address,
      ...buildOtpEmail(ns, code, purpose),
    });
    if (!result.ok) {
      // The address is personal data and the code never leaves this process
      // (invariant #2); the relay's own error is what an operator needs.
      this.logger.error(
        `mail send failed purpose=${purpose}: ${'error' in result ? result.error : ''}`,
      );
      throw new BadRequestException(BackendI18nKeys.errors.otp.emailSendFailed);
    }
  }
}
