import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TenantSmsMode, TenantType } from '@prisma/client';
import { IOtpSender } from './otp-sender.interface';
import { OtpChannel, OtpPurpose } from '../otp.interface';
import { LocaleService } from '../../../locale/locale.service';
import { CrossTenantPrismaService } from '../../../prisma/cross-tenant-prisma.service';
import { TenantContext } from '../../../tenant-context/tenant-context';
import { buildOtpSmsTemplate } from './otp-message.util';
import {
  BackendI18nKeys,
  CredentialVaultService,
  SmsProviderService,
  smsLineConfigured,
  smsLineCredentials,
} from '@txnet-backend/shared-core';

/**
 * OTP by SMS, on the line that belongs to who receives it (F-018-b, D-41).
 *
 * The gateway's URL is a location and stays in `SMS_API_URL`; the account and
 * the sender line are a tenant's `sms_api_key` / `sms_sender_line` vault values
 * (F-018-a, ADR-0026 rule 6), read on every send so a rotation takes effect on
 * the next code. Each send therefore writes the vault's audit rows (F-1215).
 * Whose vault is {@link SmsOtpSender.lineTenant}'s call.
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

  async isConfigured(to?: string): Promise<boolean> {
    if (!this.apiUrl || !this.vault.available) return false;
    const line = await this.lineTenant(to);
    return !!line && smsLineConfigured(this.vault, line);
  }

  async send(
    phoneNumber: string,
    code: string,
    purpose: OtpPurpose,
    lang: string,
  ): Promise<void> {
    const lineTenant = this.apiUrl && this.vault.available ? await this.lineTenant(phoneNumber) : null;
    const line = lineTenant ? await smsLineCredentials(this.vault, lineTenant, 'auth:SmsOtpSender') : null;
    if (!line) {
      // Not configured (a dev stack without an SMS contract, or a reseller
      // without its own line): a clear otp.smsNotConfigured, never the
      // platform's number in its place.
      this.logger.error('SMS_API_URL or the sms_api_key of the line this recipient is on is not configured');
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

  /**
   * **Whose vault an OTP SMS to `to` goes out on** (F-018-b, D-41) — the one
   * place that decides, for the tenant in scope:
   * - the platform owner's users: the platform's line;
   * - a reseller's **owner** (`tenant.ownerUserId`, matched on `to`): the
   *   platform's line too. The owner is the platform's customer and must be
   *   able to sign in before its own line exists;
   * - anyone else under a reseller — its staff, its users, a number not yet
   *   registered: the reseller's own line (`tenant_sms_config`
   *   `own_credentials`, active), or `null`. Never the platform's number.
   *
   * `to` absent (the anonymous channel list) is "anyone else". No tenant in
   * scope is `null`. Read on the cross-tenant pool: the platform owner's row is
   * another tenant's, and the delivery seam's scope is only the id.
   */
  private async lineTenant(to?: string): Promise<string | null> {
    const scoped = TenantContext.currentOrNull()?.id;
    if (!scoped) return null;
    const tenant = await this.db.tenant.findFirst({
      where: { id: scoped },
      select: { id: true, tenantType: true, ownerUserId: true },
    });
    if (!tenant) return null;
    if (tenant.tenantType === TenantType.platform_owner) return tenant.id;

    const isOwner =
      !!to &&
      !!(await this.db.user.findFirst({
        where: { id: tenant.ownerUserId, tenantId: tenant.id, phoneNumber: to },
        select: { id: true },
      }));
    if (isOwner) {
      const platform = await this.db.tenant.findFirst({
        where: { tenantType: TenantType.platform_owner },
        select: { id: true },
      });
      return platform?.id ?? null;
    }

    const own = await this.db.tenantSmsConfig.findFirst({
      where: { tenantId: tenant.id, mode: TenantSmsMode.own_credentials, isActive: true },
      select: { tenantId: true },
    });
    return own ? tenant.id : null;
  }
}
