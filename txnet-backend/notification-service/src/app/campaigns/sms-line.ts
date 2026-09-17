import { ConfigService } from '@nestjs/config';
import { SMS_TRANSPORT_FAILURE, SmsProviderService } from '@txnet-backend/shared-core';

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
 * Today there is one line, the platform's (`SMS_API_URL` / `SMS_API_KEY` /
 * `SMS_SENDER`, the OTP gateway's), and nothing meters or bills it. So it
 * carries only the platform owner's own campaign to the platform owner's own
 * users: a reseller's campaign would cost the platform, and a platform-wide one
 * would show a reseller's customer the platform's number. Anything else is
 * `none`, and the row fails.
 *
 * A reseller's own line (`TenantSmsConfig`, `own_credentials`) and the metered
 * platform line (`use_platform_sms`, `sms_sent`) arrive with F-018 and change
 * this function, not its callers.
 */
export class SmsLineResolver {
  constructor(private readonly platform: SmsLine | null) {}

  static fromConfig(config: ConfigService): SmsLineResolver {
    const url = config.get<string>('SMS_API_URL', '');
    const key = config.get<string>('SMS_API_KEY', '');
    const sender = config.get<string>('SMS_SENDER', '');
    return new SmsLineResolver(url && key ? platformSmsLine(new SmsProviderService(url, key), sender) : null);
  }

  lineFor(campaignTenantId: string | null, recipientTenantId: string, ownerTenantId: string | null): SmsLineAnswer {
    if (!platformOwnersOwn(campaignTenantId, recipientTenantId, ownerTenantId)) return { kind: 'none' };
    return this.platform ? { kind: 'ready', line: this.platform } : { kind: 'stalled' };
  }
}
