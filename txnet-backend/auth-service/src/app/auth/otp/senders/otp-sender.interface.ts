import { OtpChannel, OtpPurpose } from '../otp.interface';

export interface IOtpSender {
  readonly channel: OtpChannel;
  /**
   * Whether this environment actually has what the channel needs to send
   * (a bot token, SMS credentials). An allowed-but-unconfigured channel is
   * never offered to a client — see `OtpChannelRegistry`.
   */
  isConfigured(): boolean;
  /**
   * True for the messenger channels: they can only deliver to a chat id, so
   * the user must have linked (and contact-verified) that messenger first.
   * SMS needs nothing beyond the phone number.
   */
  readonly requiresLinkedAccount: boolean;
  send(
    phoneNumber: string,
    code: string,
    purpose: OtpPurpose,
    lang: string,
  ): Promise<void>;
}
