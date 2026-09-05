import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.service';
import { RateLimiter } from '../common/rate-limit/rate-limiter';
import {
  detectIdentifierType,
  normalizeIranPhone,
} from '../common/validation/phone.schema';
import {
  assertPasswordNotContainingProfile,
  PasswordContainsProfileDataError,
} from '../common/validation/strong-password.schema';
import {
  IOtpService,
  OtpChannel,
  OtpPurpose,
  OTP_SERVICE,
} from './otp/otp.interface';
import { OtpChannelRegistry } from './otp/otp-channels.service';
import { BotPlatform } from './otp/senders/bot-client.registry';
import { BotLinkService } from './bot-link/bot-link.service';
import { TokenService } from './token.service';
import { SessionService } from './session/session.service';
import { SessionStore } from './session/session.store';
import { Inject } from '@nestjs/common';
import { ok, err, safeExecute } from '../common/response/response.util';
import {
  ForgotPasswordInput,
  ForgotVerifyInput,
  LogoutInput,
  OtpVerifyInput,
  PasswordLoginInput,
  RefreshInput,
  ResetPasswordInput,
} from './auth.schema';

const LOGIN_FAILURE_LOCK_THRESHOLD = 10;
const LOGIN_FAILURE_WINDOW_SEC = 900;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rateLimiter: RateLimiter,
    private readonly tokens: TokenService,
    private readonly config: ConfigService,
    @Inject(OTP_SERVICE) private readonly otp: IOtpService,
    private readonly channels: OtpChannelRegistry,
    private readonly botLinks: BotLinkService,
    private readonly sessionService: SessionService,
    private readonly sessions: SessionStore,
  ) {}

  /** The delivery methods this environment offers, for a client to choose from. */
  otpChannels() {
    return ok({ channels: this.channels.describe() }, 'auth.otpChannels');
  }

  async loginWithPassword(
    input: PasswordLoginInput,
    ip: string,
    userAgent: string,
    lang: string,
  ) {
    return safeExecute(async () => {
      const type = detectIdentifierType(input.identifier);
      // One account is one lock. The lookup normalizes a phone number, so the
      // failure counter has to be keyed on the same normalized value: keying
      // it on the raw input would give `09...`, `+989...` and `00989...` a
      // counter each, and ten attempts would become thirty.
      const identity =
        type === 'phone'
          ? normalizeIranPhone(input.identifier)
          : input.identifier;
      const where =
        type === 'phone' ? { phoneNumber: identity } : { username: identity };

      const user = await this.prisma.user.findFirst({
        where,
        include: {
          role: {
            include: { rolePermissions: { include: { permission: true } } },
          },
        },
      });

      if (!user || user.deletedAt || user.status !== 'active') {
        return err('auth.invalidCredentials');
      }

      const failureBucket = `login-failures:${identity}`;
      const attempt = await this.rateLimiter.hit(
        failureBucket,
        LOGIN_FAILURE_LOCK_THRESHOLD,
        LOGIN_FAILURE_WINDOW_SEC,
      );
      if (!attempt.allowed) {
        return err('auth.temporarilyLocked');
      }

      if (!(await argon2.verify(user.passwordHash, input.password))) {
        return err('auth.invalidCredentials');
      }

      await this.rateLimiter.reset(failureBucket);

      // Invariant #6 (an unverified phone cannot complete password login) is
      // enforced here rather than before the password check: answered any
      // earlier, this key tells an anonymous caller that the account exists,
      // which is the account-existence oracle the single `invalidCredentials`
      // answer above exists to avoid. After a proven password it reveals
      // nothing the caller did not already know.
      if (!user.phoneVerifiedAt) {
        return err('auth.phoneVerificationRequired');
      }

      if (user.twoFactorEnabled) {
        const channel = this.resolveOtpChannel(user);
        await this.otp.issueOtp(
          user.phoneNumber!,
          OtpPurpose.login,
          channel,
          ip,
          lang,
        );
        const otpToken = this.tokens.signOtpToken(user.id);
        return ok({ requiresOtp: true, otpToken }, 'auth.otpSent');
      }

      const sessionData = await this.issueSession(user, ip, userAgent);
      return ok(sessionData, 'auth.loginSuccess');
    });
  }

  async requestLoginOtp(
    phoneNumber: string,
    channel: OtpChannel | undefined,
    ip: string,
    lang: string,
  ) {
    return safeExecute(async () => {
      const user = await this.prisma.user.findUnique({
        where: { phoneNumber },
        select: {
          id: true,
          status: true,
          phoneVerifiedAt: true,
          preferredOtpChannel: true,
        },
      });
      const resolvedChannel = this.resolveOtpChannel(user ?? {}, channel);

      const link = await this.linkIfNeeded(
        resolvedChannel,
        phoneNumber,
        OtpPurpose.login,
        ip,
        lang,
      );
      if (link) return link;

      if (user?.status === 'active' && user.phoneVerifiedAt) {
        await this.otp.issueOtp(
          phoneNumber,
          OtpPurpose.login,
          resolvedChannel,
          ip,
          lang,
        );
      }
      return ok({ accepted: true }, 'auth.otpSent');
    });
  }

  async verifyLoginOtp(input: OtpVerifyInput, ip: string, userAgent: string) {
    return safeExecute(async () => {
      if (input.otpToken) {
        const claims = this.tokens.verify(input.otpToken);
        if (!claims?.sub || claims.purpose !== 'otp_login') {
          return err('auth.invalidOtpToken');
        }
        const user = await this.prisma.user.findUnique({
          where: { id: claims.sub },
          include: {
            role: {
              include: { rolePermissions: { include: { permission: true } } },
            },
          },
        });
        if (!user || user.status !== 'active') {
          return err('auth.invalidOtpToken');
        }
        await this.otp.verifyOtp(
          user.phoneNumber!,
          OtpPurpose.login,
          input.otpCode,
        );
        const sessionData = await this.issueSession(user, ip, userAgent);
        return ok(sessionData, 'auth.loginSuccess');
      }

      if (!input.phoneNumber) return err('auth.phoneNumberRequired');
      const user = await this.prisma.user.findUnique({
        where: { phoneNumber: input.phoneNumber },
        include: {
          role: {
            include: { rolePermissions: { include: { permission: true } } },
          },
        },
      });
      if (!user || user.status !== 'active' || !user.phoneVerifiedAt) {
        return err('auth.invalidOtp');
      }
      await this.otp.verifyOtp(
        input.phoneNumber,
        OtpPurpose.login,
        input.otpCode,
      );
      const sessionData = await this.issueSession(user, ip, userAgent);
      return ok(sessionData, 'auth.loginSuccess');
    });
  }

  async refresh(input: RefreshInput, ip: string, userAgent: string) {
    return safeExecute(async () => {
      if (!input.refreshToken) return err('auth.refreshTokenRequired');
      const session = await this.prisma.session.findUnique({
        where: {
          refreshTokenHash: this.tokens.refreshHash(input.refreshToken),
        },
        include: {
          user: {
            include: {
              role: {
                include: { rolePermissions: { include: { permission: true } } },
              },
            },
          },
        },
      });
      if (!session || session.revokedAt || session.expiresAt <= new Date()) {
        return err('auth.invalidRefreshToken');
      }

      await this.sessionService.revokeSession(session.id, 'user_logout');
      const result = await this.sessionService.createSession(
        session.userId,
        ip,
        userAgent,
      );
      const accessToken = this.tokens.signAccessToken(
        session.user,
        result.session.id,
      );
      return ok(
        {
          accessToken,
          refreshToken: result.refreshToken,
          expiresIn: this.config.get<number>('JWT_ACCESS_TTL_SEC', 900),
        },
        'auth.refreshSuccess',
      );
    });
  }

  async logout(input: LogoutInput) {
    return safeExecute(async () => {
      if (!input.refreshToken)
        return ok({ success: true }, 'auth.logoutSuccess');
      const session = await this.prisma.session.findUnique({
        where: {
          refreshTokenHash: this.tokens.refreshHash(input.refreshToken),
        },
        select: { id: true },
      });
      if (session)
        await this.sessionService.revokeSession(session.id, 'user_logout');
      return ok({ success: true }, 'auth.logoutSuccess');
    });
  }

  async forgotPassword(input: ForgotPasswordInput, ip: string, lang: string) {
    return safeExecute(async () => {
      const user = await this.prisma.user.findUnique({
        where: { phoneNumber: input.phoneNumber },
        select: { id: true, status: true, preferredOtpChannel: true },
      });
      const channel = this.resolveOtpChannel(user ?? {}, input.channel);

      const link = await this.linkIfNeeded(
        channel,
        input.phoneNumber,
        OtpPurpose.password_reset,
        ip,
        lang,
      );
      if (link) return link;

      if (user?.status === 'active') {
        await this.otp.issueOtp(
          input.phoneNumber,
          OtpPurpose.password_reset,
          channel,
          ip,
          lang,
        );
      }
      return ok({ accepted: true }, 'auth.resetOtpSent');
    });
  }

  async verifyForgotPassword(input: ForgotVerifyInput) {
    return safeExecute(async () => {
      await this.otp.verifyOtp(
        input.phoneNumber,
        OtpPurpose.password_reset,
        input.otpCode,
      );
      const user = await this.prisma.user.findUnique({
        where: { phoneNumber: input.phoneNumber },
        select: { id: true },
      });
      if (!user) return err('auth.invalidResetRequest');
      const resetToken = this.tokens.signResetToken(input.phoneNumber, user.id);
      return ok({ resetToken }, 'auth.resetTokenGenerated');
    });
  }

  async resetPassword(input: ResetPasswordInput, ip: string, userAgent: string) {
    return safeExecute(async () => {
      const claims = this.tokens.verify(input.resetToken);
      if (claims.purpose !== 'password_reset')
        return err('auth.invalidResetToken');
      const user = await this.prisma.user.findUnique({
        where: { id: claims.sub },
        select: { id: true, username: true, fullName: true, phoneNumber: true },
      });
      if (!user) return err('auth.invalidResetToken');

      try {
        assertPasswordNotContainingProfile(input.newPassword, user);
      } catch (e) {
        if (e instanceof PasswordContainsProfileDataError) {
          return err('password.containsProfileData');
        }
        throw e;
      }

      const passwordHash = await argon2.hash(input.newPassword, {
        type: argon2.argon2id,
      });

      await this.prisma.$transaction([
        this.prisma.user.update({
          where: { id: user.id },
          data: { passwordHash },
        }),
        this.prisma.session.updateMany({
          where: { userId: user.id, revokedAt: null },
          data: { revokedAt: new Date(), revokedReason: 'password_change' },
        }),
      ]);

      // Drop every cached session for this user so the new password takes
      // effect on all devices immediately.
      await this.sessions.dropAllForUser(user.id);

      // Every session is gone, including any the person resetting was holding
      // — so this device is signed back in here, on a session minted after the
      // revocation. The net effect is the requested "everything except the
      // one in front of me", without weakening identity/invariants.md #3: the
      // revocation is still total, and no pre-reset session survives it.
      const full = await this.findUserForSession(user.id);
      const sessionData = await this.issueSession(full, ip, userAgent);

      return ok(
        { success: true, ...sessionData },
        'auth.passwordResetSuccess',
      );
    });
  }

  async findUserForSession(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        role: {
          include: { rolePermissions: { include: { permission: true } } },
        },
      },
    });
  }

  async createSessionForUser(user: any, ip: string, userAgent: string) {
    return this.issueSession(user, ip, userAgent);
  }

  private async issueSession(user: any, ip: string, userAgent: string) {
    const result = await this.sessionService.createSession(
      user.id,
      ip,
      userAgent,
    );
    return {
      accessToken: this.tokens.signAccessToken(user, result.session.id),
      refreshToken: result.refreshToken,
      expiresIn: this.config.get<number>('JWT_ACCESS_TTL_SEC', 900),
    };
  }

  /**
   * A messenger channel can only deliver to a chat this account has proven it
   * owns. When that proof is missing, the answer to "send me a code" is a
   * deep link into the bot instead of a code — see `BotLinkService`.
   *
   * This runs before the account is looked at, and for every phone number
   * alike: branching on whether the account exists would turn the link
   * response into an account-existence oracle. Whoever holds the link still
   * cannot complete it without controlling that phone number in the messenger.
   *
   * Returns null when nothing is needed and the caller should just send.
   */
  private async linkIfNeeded(
    channel: OtpChannel,
    phoneNumber: string,
    purpose: OtpPurpose,
    ip: string,
    lang: string,
  ) {
    if (!this.channels.requiresLink(channel)) return null;
    // Rejects a channel switched off in this environment before we hand out a
    // link the bot could not honour.
    this.channels.assertUsable(channel);

    const platform = channel as unknown as BotPlatform;
    if (await this.botLinks.hasVerifiedLink(phoneNumber, platform)) return null;

    const started = await this.botLinks.startLink({
      platform,
      phoneNumber,
      purpose,
      lang,
      ip,
    });
    return ok({ accepted: true, ...started }, 'auth.botLinkRequired');
  }

  /**
   * OTP channel selection priority:
   * 1) the channel explicitly passed in this request
   * 2) the user's saved `preferredOtpChannel`
   * 3) the first channel this environment offers (`OTP_ALLOWED_CHANNELS`
   *    order) — which is not necessarily SMS: an operator running
   *    `OTP_ALLOWED_CHANNELS=telegram,bale` has no SMS to fall back to.
   * A saved preference for a channel that has since been switched off is
   * ignored rather than fatal, so turning a channel off never strands the
   * users who had chosen it.
   *
   * Note: `preferredOtpChannel` here must stay typed as the real
   * `OtpChannel` enum from Prisma (not `string`), because Prisma returns
   * enum fields typed as the enum, and using `string` here would make TS
   * see it as incompatible with the actual user object.
   */
  private resolveOtpChannel(
    user: { preferredOtpChannel?: OtpChannel | null },
    explicitChannel?: OtpChannel,
  ): OtpChannel {
    // An explicitly named channel is never silently swapped: if it is off,
    // OtpService/linkIfNeeded rejects the request so the client can say why.
    if (explicitChannel) return explicitChannel;
    if (user.preferredOtpChannel && this.channels.isAvailable(user.preferredOtpChannel)) {
      return user.preferredOtpChannel;
    }
    const fallback = this.channels.defaultChannel();
    if (!fallback) throw new BadRequestException('otp.noChannelAvailable');
    return fallback;
  }
}
