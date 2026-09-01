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
    private readonly sessionService: SessionService,
    private readonly sessions: SessionStore,
  ) {}

  async loginWithPassword(
    input: PasswordLoginInput,
    ip: string,
    userAgent: string,
    lang: string,
  ) {
    return safeExecute(async () => {
      const type = detectIdentifierType(input.identifier);
      const where =
        type === 'phone'
          ? { phoneNumber: normalizeIranPhone(input.identifier) }
          : { username: input.identifier };

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
      if (!user.phoneVerifiedAt) {
        return err('auth.phoneVerificationRequired');
      }

      const failureBucket = `login-failures:${input.identifier}`;
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
      if (user?.status === 'active' && user.phoneVerifiedAt) {
        const resolvedChannel = this.resolveOtpChannel(user, channel);
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
      if (user?.status === 'active') {
        const channel = this.resolveOtpChannel(user, (input as any).channel);
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

  async resetPassword(input: ResetPasswordInput) {
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

      return ok({ success: true }, 'auth.passwordResetSuccess');
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
   * OTP channel selection priority:
   * 1) the channel explicitly passed in this request
   * 2) the user's saved `preferredOtpChannel`
   * 3) default: sms
   * Whether the channel is allowed in the current environment (env-based)
   * is checked inside OtpService.
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
    if (explicitChannel) return explicitChannel;
    if (user.preferredOtpChannel) {
      return user.preferredOtpChannel;
    }
    return OtpChannel.sms;
  }
}
