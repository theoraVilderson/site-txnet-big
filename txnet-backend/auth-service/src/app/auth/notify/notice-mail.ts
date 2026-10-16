import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MAIL_RECIPIENT_REFUSED, MailProviderService } from '@txnet-backend/shared-core';

import { mailProviderOf } from '../../common/mail/mail-provider';

/**
 * A notice by email (F-1006-a): the platform's relay, plain text, to the
 * person's verified address. A notice nobody asked to email never comes here
 * — only a channel `only` names (a scheduled report).
 */
@Injectable()
export class NoticeMailer {
  private readonly provider: MailProviderService | null;

  constructor(config: ConfigService) {
    this.provider = mailProviderOf(config);
  }

  /**
   * True when it left. An address refused for good is false — asking again
   * changes nothing. A relay unset or unreachable throws, so the channel stays
   * owed and the event is delivered again.
   */
  async send(to: string, subject: string, text: string): Promise<boolean> {
    if (!this.provider) throw new Error('SMTP_HOST / MAIL_FROM is not configured');
    const result = await this.provider.sendMail({ to, subject, text });
    if (result.ok) return true;
    // `msg` is the kind of failure (`MailProviderService`), `error` the relay's own words.
    if (result.msg === MAIL_RECIPIENT_REFUSED) return false;
    throw new Error(`notice mail failed (${result.msg}): ${'error' in result ? String(result.error) : ''}`);
  }
}
