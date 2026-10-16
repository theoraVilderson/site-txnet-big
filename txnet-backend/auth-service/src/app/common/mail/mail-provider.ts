import { ConfigService } from '@nestjs/config';
import { MailProviderService } from '@txnet-backend/shared-core';

/**
 * The platform's SMTP relay as this service configures it (D-39), or `null`
 * when `SMTP_HOST` / `MAIL_FROM` are unset — one reading of the settings for
 * every mail auth-service sends: a verification code (F-035-g) and a notice
 * by email (F-1006-a).
 */
export function mailProviderOf(config: ConfigService): MailProviderService | null {
  const host = config.get<string>('SMTP_HOST');
  const from = config.get<string>('MAIL_FROM');
  if (!host || !from) return null;
  return new MailProviderService({
    host,
    port: Number(config.get<number>('SMTP_PORT', 587)),
    secure: config.get<string>('SMTP_SECURE', 'false') === 'true',
    user: config.get<string>('SMTP_USER'),
    pass: config.get<string>('SMTP_PASS'),
    from,
  });
}
