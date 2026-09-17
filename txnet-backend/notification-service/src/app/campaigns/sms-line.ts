import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CredentialVaultService,
  SMS_TRANSPORT_FAILURE,
  SmsProviderService,
  smsLineCredentials,
} from '@txnet-backend/shared-core';

/** What one send came to. Only `refused` is final for the row; `line_down` is the operator's problem. */
export type SmsSend =
  | { status: 'sent' }
  | { status: 'refused' | 'retry' | 'line_down'; description: string };

export interface SmsLine {
  send(to: string, text: string): Promise<SmsSend>;
}

export type SmsLineAnswer = { kind: 'ready'; line: SmsLine } | { kind: 'none' } | { kind: 'stalled' };

/** Gateway answers that mean this number, not the account, is the problem. */
const REFUSED_RECIPIENT = new Set(['InvalidReceiverNumber']);

/**
 * The platform's gateway as a campaign line. The text goes as stored: no
 * `vars`, so a `{{…}}` an admin typed reaches the user untouched.
 */
export function platformSmsLine(provider: Pick<SmsProviderService, 'sendSMS'>, sender: string): SmsLine {
  return {
    async send(to, text) {
      const result = await provider.sendSMS({ msg: text, to }, sender);
      if (result.ok) return { status: 'sent' };
      if (REFUSED_RECIPIENT.has(result.msg)) return { status: 'refused', description: result.msg };
      if (result.msg === SMS_TRANSPORT_FAILURE) return { status: 'retry', description: result.msg };
      // Bad credentials, no credit, a blocked sender: every next row would get the same answer.
      return { status: 'line_down', description: String(result.msg) };
    },
  };
}

/**
 * D-38 (invariant 10): a line the platform pays for and signs as the platform
 * carries only the platform owner's own campaign to the platform owner's own
 * users. The SMS line and the mail server (F-035-h) both ask this.
 */
export function platformOwnersOwn(campaignTenantId: string | null, recipientTenantId: string, ownerTenantId: string | null): boolean {
  return !!ownerTenantId && campaignTenantId === ownerTenantId && recipientTenantId === ownerTenantId;
}

/**
 * **Which SMS line a campaign row goes out on, and who pays for it** (F-035-f,
 * D-38, invariant 10) — the one place that decides.
 *
 * Today there is one line, the platform's: `SMS_API_URL` and the platform
 * owner's `sms_api_key` / `sms_sender_line` vault values (F-018-a), the OTP
 * sender's. Nothing meters or bills it, so it carries only the platform owner's
 * own campaign to the platform owner's own users: a reseller's campaign would
 * cost the platform, and a platform-wide one would show a reseller's customer
 * the platform's number. Anything else is `none`, and the row fails.
 *
 * One resolver per delivery run ({@link SmsLineSource}), so the credentials are
 * read once per run rather than once per row. A reseller's own line
 * (`TenantSmsConfig`, `own_credentials`) and the metered platform line
 * (`use_platform_sms`, `sms_sent`) are F-035-i and change this function, not
 * its callers.
 */
export class SmsLineResolver {
  constructor(private readonly platform: SmsLine | null) {}

  lineFor(campaignTenantId: string | null, recipientTenantId: string, ownerTenantId: string | null): SmsLineAnswer {
    if (!platformOwnersOwn(campaignTenantId, recipientTenantId, ownerTenantId)) return { kind: 'none' };
    return this.platform ? { kind: 'ready', line: this.platform } : { kind: 'stalled' };
  }
}

/**
 * Opens a delivery run's {@link SmsLineResolver} from the vault (F-018-a).
 *
 * No URL, no vault, no owner or no key is no line, and SMS rows stall as they
 * did with an empty `SMS_API_KEY`. A vault that fails to read is logged and
 * stalls them too: an outage delays a campaign rather than burning it.
 */
@Injectable()
export class SmsLineSource {
  private readonly logger = new Logger(SmsLineSource.name);
  private readonly apiUrl: string;

  constructor(
    config: ConfigService,
    private readonly vault: CredentialVaultService,
    private readonly providerFor: (apiUrl: string, apiKey: string) => Pick<SmsProviderService, 'sendSMS'> = (url, key) =>
      new SmsProviderService(url, key),
  ) {
    this.apiUrl = config.get<string>('SMS_API_URL', '');
  }

  async resolverFor(ownerTenantId: string | null): Promise<SmsLineResolver> {
    if (!this.apiUrl || !ownerTenantId || !this.vault.available) return new SmsLineResolver(null);
    try {
      const line = await smsLineCredentials(this.vault, ownerTenantId, 'notification:SmsLineSource');
      return new SmsLineResolver(line ? platformSmsLine(this.providerFor(this.apiUrl, line.apiKey), line.sender) : null);
    } catch (error) {
      this.logger.warn(`the platform SMS line could not be read from the vault: ${error instanceof Error ? error.name : 'error'}`);
      return new SmsLineResolver(null);
    }
  }
}
