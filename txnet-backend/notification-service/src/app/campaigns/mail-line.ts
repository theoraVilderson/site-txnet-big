import { ConfigService } from '@nestjs/config';
import { MAIL_ACCOUNT_REFUSED, MAIL_RECIPIENT_REFUSED, MailProviderService } from '@txnet-backend/shared-core';

import { SmsSend, platformOwnersOwn } from './sms-line';

/** What one send came to, as for SMS: only `refused` is final for the row; `line_down` is the operator's problem. */
export type MailSend = SmsSend;

export interface MailLine {
  send(to: string, message: { subject: string; body: string }): Promise<MailSend>;
}

export type MailLineAnswer = { kind: 'ready'; line: MailLine } | { kind: 'none' } | { kind: 'stalled' };

/** The platform's SMTP server as a campaign line. The body goes as plain text, as stored or published. */
export function platformMailLine(provider: Pick<MailProviderService, 'sendMail'>): MailLine {
  return {
    async send(to, { subject, body }) {
      const result = await provider.sendMail({ to, subject, text: body });
      if (result.ok) return { status: 'sent' };
      const description = 'error' in result ? String(result.error) : result.msg;
      if (result.msg === MAIL_RECIPIENT_REFUSED) return { status: 'refused', description };
      // Credentials or a permanent refusal of the message: every next row would get the same answer.
      if (result.msg === MAIL_ACCOUNT_REFUSED) return { status: 'line_down', description };
      return { status: 'retry', description };
    },
  };
}

/**
 * **Which mail server a campaign email goes out on** (F-035-h, D-38 as for SMS,
 * invariant 10) — the one place that decides.
 *
 * Today there is one, the platform's (`SMTP_*` / `MAIL_FROM`, the OTP one), and
 * its sender address is the platform's domain. So it carries only the platform
 * owner's own campaign to the platform owner's own users: a reseller's customer
 * would otherwise get mail signed by the platform. A reseller's own sending
 * domain (F-112) changes this function, not its callers.
 */
export class MailLineResolver {
  constructor(private readonly platform: MailLine | null) {}

  static fromConfig(config: ConfigService): MailLineResolver {
    const host = config.get<string>('SMTP_HOST', '');
    const from = config.get<string>('MAIL_FROM', '');
    if (!host || !from) return new MailLineResolver(null);
    const provider = new MailProviderService({
      host,
      port: config.get<number>('SMTP_PORT', 587),
      secure: config.get<string>('SMTP_SECURE', 'false') === 'true',
      user: config.get<string>('SMTP_USER', '') || undefined,
      pass: config.get<string>('SMTP_PASS', '') || undefined,
      from,
    });
    return new MailLineResolver(platformMailLine(provider));
  }

  lineFor(campaignTenantId: string | null, recipientTenantId: string, ownerTenantId: string | null): MailLineAnswer {
    if (!platformOwnersOwn(campaignTenantId, recipientTenantId, ownerTenantId)) return { kind: 'none' };
    return this.platform ? { kind: 'ready', line: this.platform } : { kind: 'stalled' };
  }
}
