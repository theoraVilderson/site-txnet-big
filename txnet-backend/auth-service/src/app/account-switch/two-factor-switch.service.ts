import { WITH_KEYS } from '../auth/permissions/user-with-keys';
import type { TwoFactorSwitchCodeInput, TwoFactorSwitchPasswordInput } from './account-switch.schema';
import { Inject, Injectable } from '@nestjs/common';
import { OtpPurpose } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { TokenService } from '../auth/token.service';
import { IOtpService, OTP_SERVICE } from '../auth/otp/otp.interface';
import { SurfaceOwnerService } from '../auth/surface-owner/surface-owner.service';
import { err, safeExecute } from '../common/response/response.util';
import { SwitchScope } from '../common/security/switch-scope';
import { AccountSwitchService } from './account-switch.service';

/** What the role's keys are read from, so the code step can ask the person's whole answer. */

/**
 * A switch that proves both factors at the moment it is made (ADR-0145): the
 * member's own password, then a code to their own number. The one-click switch
 * stays closed to a holder of `*`; this is how they are reached from a browser
 * that holds other accounts, without signing those out.
 */
@Injectable()
export class TwoFactorSwitchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly accounts: AccountSwitchService,
    private readonly surfaceOwners: SurfaceOwnerService,
    private readonly tokens: TokenService,
    @Inject(OTP_SERVICE) private readonly otp: IOtpService,
  ) {}

  /** Step 1: the member's password; answered with the code step's `otpToken`. */
  async begin(
    scopeKey: SwitchScope | null,
    callerUserId: string,
    input: TwoFactorSwitchPasswordInput,
    ip: string,
    lang: string,
  ) {
    return safeExecute(async () => {
      // Membership first: nothing is proven or sent for anyone outside the group.
      if (!scopeKey || !(await this.sameGroup(scopeKey, callerUserId, input.userId))) {
        return err('accountSwitch.notAMember');
      }
      const target = await this.surfaceOwners.admissibleUser(input.userId, WITH_KEYS);
      if (!target) return err('accountSwitch.notAMember');
      const identifier = target.username ?? target.phoneNumber;
      const proven = identifier ? await this.auth.proveAccountByPassword(identifier, input.password) : null;
      if (proven?.id !== target.id) return err('accountSwitch.proofFailed');
      return this.auth.askSecondFactor(target, ip, lang, input.channel);
    });
  }

  /** Step 2: the code, on the number of the account the token names; then the switch, as two-factor. */
  async finish(
    scopeKey: SwitchScope | null,
    callerUserId: string,
    callerSessionId: string,
    input: TwoFactorSwitchCodeInput,
    ip: string,
    userAgent: string,
  ) {
    return safeExecute(async () => {
      const claims = this.tokens.verify(input.otpToken);
      if (!claims?.sub || claims.purpose !== 'otp_login') return err('auth.invalidOtpToken');
      const target = await this.surfaceOwners.admissibleUser(claims.sub, {});
      if (!target?.phoneNumber) return err('auth.invalidOtpToken');
      await this.otp.verifyOtp(target.phoneNumber, OtpPurpose.login, input.otpCode);
      return this.accounts.switchTo(scopeKey, callerUserId, callerSessionId, target.id, ip, userAgent, true);
    });
  }

  private async sameGroup(scopeKey: SwitchScope, callerUserId: string, targetUserId: string): Promise<boolean> {
    const [caller, target] = await Promise.all(
      [callerUserId, targetUserId].map((userId) =>
        this.prisma.linkedAccountMember.findUnique({ where: { scopeKey_userId: { scopeKey, userId } } }),
      ),
    );
    return !!caller && !!target && caller.groupId === target.groupId;
  }
}
