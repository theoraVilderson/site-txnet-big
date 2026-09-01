import { OtpChannel, OtpPurpose } from '@prisma/client';

// Re-exported so the rest of the app can keep importing from
// './otp.interface' even if the underlying source ever changes.
export { OtpChannel, OtpPurpose };

export const OTP_SERVICE = Symbol('OTP_SERVICE');

export interface IOtpService {
  issueOtp(
    phoneNumber: string,
    purpose: OtpPurpose,
    channel: OtpChannel,
    requestIp: string,
    lang: string,
  ): Promise<void>;
  verifyOtp(
    phoneNumber: string,
    purpose: OtpPurpose,
    inputCode: string,
  ): Promise<boolean>;
}
