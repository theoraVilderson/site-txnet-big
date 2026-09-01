import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IOtpSender } from './otp-sender.interface';
import { OtpChannel, OtpPurpose } from '../otp.interface';
import { SmsProviderService } from './sms-provider/sms-provider.service';
import { LocaleService } from '../../../locale/locale.service';
import { buildOtpSmsTemplate } from './otp-message.util';

@Injectable()
export class SmsOtpSender implements IOtpSender {
  readonly channel = OtpChannel.sms;
  private readonly logger = new Logger(SmsOtpSender.name);
  private readonly provider: SmsProviderService | null;
  private readonly sender: string;

  constructor(
    private readonly config: ConfigService,
    private readonly localeService: LocaleService,
  ) {
    const apiUrl = this.config.get<string>('SMS_API_URL');
    const apiKey = this.config.get<string>('SMS_API_KEY');
    this.sender = this.config.get<string>('SMS_SENDER', '');

    // If not configured (e.g. dev environment without an SMS contract),
    // leave provider as null so we throw a clear otp.smsNotConfigured
    // error instead of failing silently.
    this.provider =
      apiUrl && apiKey ? new SmsProviderService(apiUrl, apiKey) : null;
  }

  async send(
    phoneNumber: string,
    code: string,
    purpose: OtpPurpose,
    lang: string,
  ): Promise<void> {
    if (!this.provider) {
      this.logger.error('SMS_API_URL / SMS_API_KEY is not configured');
      throw new BadRequestException('otp.smsNotConfigured');
    }

    const ns = this.localeService.getNamespace(lang, 'otp');
    const msg = buildOtpSmsTemplate(ns, purpose);

    const result = await this.provider.sendSMS(
      { msg, to: phoneNumber, vars: { code } },
      this.sender,
    );
    if (!result.ok) {
      this.logger.error(
        `SMS send failed for ${phoneNumber} purpose=${purpose}: ${result.msg}`,
      );
      throw new BadRequestException('otp.smsSendFailed');
    }
  }
}
