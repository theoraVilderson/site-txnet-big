import { Injectable, Logger } from '@nestjs/common';
import { IOtpService, OtpChannel, OtpPurpose } from './otp.interface';

/**
 * PLACEHOLDER — section N4 (atomic issueOtp/verifyOtp over Redis, per
 * section 4 of the design doc) is not implemented yet. This class only
 * exists so the registration flow (N3) compiles and runs without blocking
 * on the OTP dependency. It must be replaced in N4 with the real
 * implementation (register the real provider instead of this class in
 * auth.module.ts).
 */
@Injectable()
export class OtpPlaceholderService implements IOtpService {
  private readonly logger = new Logger(OtpPlaceholderService.name);

  async issueOtp(
    phoneNumber: string,
    purpose: OtpPurpose,
    channel: OtpChannel,
    requestIp: string,
    lang: string,
  ): Promise<void> {
    this.logger.warn(
      `[PLACEHOLDER] issueOtp called for ${phoneNumber} purpose=${purpose} channel=${channel} ip=${requestIp} lang=${lang} — real logic lands in N4`,
    );
  }

  async verifyOtp(): Promise<boolean> {
    this.logger.warn('[PLACEHOLDER] verifyOtp called — real logic lands in N4');
    return true;
  }
}
