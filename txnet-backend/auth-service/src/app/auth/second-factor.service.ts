import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { err, safeExecute } from '../common/response/response.util';
import { runWithTenant } from '../tenant-context/tenant-context';
import { SurfaceOwnerService } from './surface-owner/surface-owner.service';
import { TokenService } from './token.service';
import { AuthService } from './auth.service';
import type { SecondFactorSendInput } from './auth.schema';

/**
 * The code after a proven password, sent by the channel the person chose
 * (SA-1-d) — the phone login's picker, on the password login's second step.
 * The password step's `otpToken` is the whole proof; a send can be repeated
 * with another channel, each one under the OTP service's own limits.
 */
@Injectable()
export class SecondFactorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly surfaceOwners: SurfaceOwnerService,
    private readonly auth: AuthService,
  ) {}

  /** Sends the code (or hands over the bot link) for the account the token names. */
  async send(input: SecondFactorSendInput, ip: string, lang: string) {
    return safeExecute(async () => {
      const claims = this.tokens.verify(input.otpToken);
      if (!claims?.sub || claims.purpose !== 'otp_login') return err('auth.invalidOtpToken');
      const user = await this.prisma.user.findUnique({ where: { id: claims.sub } });
      if (user) return this.auth.askSecondFactor(user, ip, lang, input.channel);
      // ADR-0059 (4): the owner's code is issued in their own tenant, where
      // `verifyLoginOtp` checks it for the same token.
      const owner = await this.surfaceOwners.ownerMatching({}, {});
      if (owner?.user.id !== claims.sub) return err('auth.invalidOtpToken');
      return runWithTenant(owner.scope, () => this.auth.askSecondFactor(owner.user, ip, lang, input.channel));
    });
  }
}
