import { Injectable } from '@nestjs/common';
import { err } from '../../common/response/response.util';
import { AuthService } from '../auth.service';
import { RegisterService } from '../register/register.service';
import type { OtpResendInput } from '../auth.schema';
import { OtpResendGrants, ResendStep } from './otp-resend.store';

/**
 * "Resend code" sends a code (F-0201-f, the user's server route, 2026-10-08):
 * it replays the step that sent the first one, on that step's grant. The
 * answer, the account checks and the OTP cooldown are therefore the step's own.
 */
@Injectable()
export class OtpResendService {
  constructor(
    private readonly grants: OtpResendGrants,
    private readonly auth: AuthService,
    private readonly register: RegisterService,
  ) {}

  /** The step's own answer, or `otp.resendExpired` when its grant is gone or spent. */
  async resend(input: OtpResendInput, ip: string, lang: string) {
    if (!(await this.grants.spend(input.purpose, input.phoneNumber))) return err('otp.resendExpired');
    const { phoneNumber, channel } = input;
    const replay: Record<ResendStep, () => Promise<unknown>> = {
      login: () => this.auth.requestLoginOtp(phoneNumber, channel, ip, lang),
      forgot: () => this.auth.forgotPassword({ phoneNumber, channel }, ip, lang),
      register: () => this.register.resendCode(phoneNumber, channel, ip, lang),
    };
    return replay[input.purpose]();
  }
}
