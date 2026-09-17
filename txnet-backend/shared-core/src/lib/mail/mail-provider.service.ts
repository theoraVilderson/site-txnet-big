import { createTransport, type Transporter } from 'nodemailer';
import { err, ok, type ResponseType } from '../envelope/response';

/** The failure `msg` when the SMTP server was not reached or refused the message. */
export const MAIL_TRANSPORT_FAILURE = 'mail failed to send';

export interface MailProviderOptions {
  host: string;
  port: number;
  /** Implicit TLS (port 465). `false` still upgrades with STARTTLS when offered. */
  secure: boolean;
  /** Both or neither: a relay such as Mailpit in dev takes no credentials. */
  user?: string;
  pass?: string;
  /** The envelope and header sender, e.g. `TXNet <no-reply@example.com>`. */
  from: string;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/**
 * The platform's mail driver: plain SMTP (D-39), so any provider — a hosted
 * relay, a self-hosted MTA, Mailpit on a dev machine — is a change of env, not
 * of code. Beside `SmsProviderService` and shaped like it, so OTP delivery
 * (F-035-g) and campaigns (F-035-h) share one driver: a refusal is an `err`
 * envelope, never a throw, and the caller decides what a failure means.
 *
 * Timeouts are short on purpose. This runs on the delivery side of the OTP
 * queue, not in a user's request, but a hung SMTP server would still hold a
 * worker's message until the broker gave up on it.
 */
export class MailProviderService {
  private readonly transport: Transporter;
  private readonly from: string;

  constructor(options: MailProviderOptions, transport?: Transporter) {
    this.from = options.from;
    this.transport =
      transport ??
      createTransport({
        host: options.host,
        port: options.port,
        secure: options.secure,
        auth:
          options.user && options.pass
            ? { user: options.user, pass: options.pass }
            : undefined,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
      });
  }

  async sendMail(message: MailMessage): Promise<ResponseType<boolean, string>> {
    try {
      await this.transport.sendMail({ from: this.from, ...message });
      return ok(true, 'mail sent');
    } catch (e) {
      return err(MAIL_TRANSPORT_FAILURE, e instanceof Error ? e.message : String(e));
    }
  }
}
