import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TenantType } from '@prisma/client';
import { IOtpSender } from './otp-sender.interface';
import { OtpChannel, OtpPurpose } from '../otp.interface';
import { LocaleService } from '../../../locale/locale.service';
import { CrossTenantPrismaService } from '../../../prisma/cross-tenant-prisma.service';
import { buildOtpSmsTemplate } from './otp-message.util';
import {
  BackendI18nKeys,
  CredentialVaultService,
  SmsProviderService,
  smsLineConfigured,
  smsLineCredentials,
} from '@txnet-backend/shared-core';

/**
 * OTP by SMS, on the platform's line.
 *
 * The gateway's URL is a location and stays in `SMS_API_URL`; the account and
 * the sender line are the platform owner's `sms_api_key` / `sms_sender_line`
 * vault values (F-018-a, ADR-0026 rule 6), read on every send so a rotation
 * takes effect on the next code. Each send therefore writes the vault's audit
 * rows (F-1215).
 */
@Injectable()
export class SmsOtpSender implements IOtpSender {
  readonly channel = OtpChannel.sms;
  readonly requiresLinkedAccount = false;
  private readonly logger = new Logger(SmsOtpSender.name);
  private readonly apiUrl: string;
  private providerFor = (apiUrl: string, apiKey: string): Pick<SmsProviderService, 'sendSMS'> =>
    new SmsProviderService(apiUrl, apiKey);

  constructor(
    config: ConfigService,
    private readonly localeService: LocaleService,
    private readonly vault: CredentialVaultService,
    private readonly db: CrossTenantPrismaService,
  ) {
    this.apiUrl = config.get<string>('SMS_API_URL', '');
  }

  async isConfigured(): Promise<boolean> {
    if (!this.apiUrl || !this.vault.available) return false;
    const owner = await this.ownerTenantId();
    return !!owner && smsLineConfigured(this.vault, owner);
  }

  async send(
    phoneNumber: string,
    code: string,
    purpose: OtpPurpose,
    lang: string,
  ): Promise<void> {
    const owner = this.apiUrl && this.vault.available ? await this.ownerTenantId() : null;
    const line = owner ? await smsLineCredentials(this.vault, owner, 'auth:SmsOtpSender') : null;
    if (!line) {
      // Not configured (e.g. a dev stack without an SMS contract): a clear
      // otp.smsNotConfigured instead of failing silently.
      this.logger.error("SMS_API_URL or the platform owner's sms_api_key is not configured");
      throw new BadRequestException(BackendI18nKeys.errors.otp.smsNotConfigured);
    }

    const ns = this.localeService.getNamespace(lang, 'notifications');
    const msg = buildOtpSmsTemplate(ns, purpose);

    const result = await this.providerFor(this.apiUrl, line.apiKey).sendSMS(
      { msg, to: phoneNumber, vars: { code } },
      line.sender,
    );
    if (!result.ok) {
      this.logger.error(
        `SMS send failed for ${phoneNumber} purpose=${purpose}: ${result.msg}`,
      );
      throw new BadRequestException(BackendI18nKeys.errors.otp.smsSendFailed);
    }
  }

  private async ownerTenantId(): Promise<string | null> {
    const owner = await this.db.tenant.findFirst({
      where: { tenantType: TenantType.platform_owner },
      select: { id: true },
    });
    return owner?.id ?? null;
  }
}
