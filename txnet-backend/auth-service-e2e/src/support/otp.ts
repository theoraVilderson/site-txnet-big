/**
 * How a test learns the six digits.
 *
 * With `OTP_DELIVERY_MODE=console` the real `OtpService` runs unchanged —
 * same Redis record, same hash, same cooldown and attempt counter — and only
 * the last step, handing the code to a sender, is replaced by a line on
 * stdout. Reading that line is the closest a test can get to being the user
 * holding the phone, without stubbing anything the API does.
 *
 *   [otp:register_phone_verify:sms] +989121234567: 483920
 */
const OTP_LINE = /^\[otp:([a-z_]+):([a-z]+)\] (\S+): (\d{6})$/;

export interface OtpDelivery {
  purpose: string;
  channel: string;
  phoneNumber: string;
  code: string;
}

export class OtpInbox {
  private readonly deliveries: OtpDelivery[] = [];
  private original?: typeof console.info;

  /** Start intercepting. Idempotent. */
  install(): void {
    if (this.original) return;
    this.original = console.info.bind(console);
    console.info = (...args: unknown[]) => {
      const match =
        args.length === 1 && typeof args[0] === 'string'
          ? OTP_LINE.exec(args[0])
          : null;
      if (match) {
        const [, purpose, channel, phoneNumber, code] = match;
        this.deliveries.push({ purpose, channel, phoneNumber, code });
        return;
      }
      this.original?.(...(args as []));
    };
  }

  restore(): void {
    if (this.original) console.info = this.original;
    this.original = undefined;
  }

  clear(): void {
    this.deliveries.length = 0;
  }

  all(): readonly OtpDelivery[] {
    return this.deliveries;
  }

  /** The newest code sent to this number, failing loudly when none was. */
  latest(phoneNumber: string, purpose?: string): string {
    const match = [...this.deliveries]
      .reverse()
      .find(
        (d) =>
          d.phoneNumber === phoneNumber &&
          (purpose === undefined || d.purpose === purpose),
      );
    if (!match) {
      throw new Error(
        `no OTP was delivered to ${phoneNumber}${
          purpose ? ` for ${purpose}` : ''
        } — deliveries so far: ${JSON.stringify(this.deliveries)}`,
      );
    }
    return match.code;
  }

  /** True when nothing at all was sent — the assertion for a silent branch. */
  isEmpty(): boolean {
    return this.deliveries.length === 0;
  }
}
