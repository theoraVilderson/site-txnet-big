import { OtpChannel, OtpPurpose } from '../otp.interface';

export interface IOtpSender {
  readonly channel: OtpChannel;
  send(
    phoneNumber: string,
    code: string,
    purpose: OtpPurpose,
    lang: string,
  ): Promise<void>;
}
