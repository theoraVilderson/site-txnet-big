import { RedisTtl } from '@txnet-backend/shared-core';
import {
  RateLimitBucket,
  rateLimitBucketKey,
} from '@txnet-backend/shared-core';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { SessionRevokedReason } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RateLimiter } from '../common/rate-limit/rate-limiter';
import {
  detectIdentifierType,
  normalizePhone,
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
import { otpRealtimeChannel } from '@txnet-backend/shared-core';
import {
  OtpDeliveryStore,
  type OtpDeliveryHandles,
} from './otp/otp-delivery.store';
import { BotPlatform } from '@txnet-backend/messenger';
import { BotLinkService } from './bot-link/bot-link.service';
import { TokenService } from './token.service';
import { SessionService } from './session/session.service';
import { SessionStore } from './session/session.store';
import { Inject } from '@nestjs/common';
import {
  ok,
  err,
  safeExecute,
  type ResponseType,
} from '../common/response/response.util';
import {
  ForgotPasswordInput,
  ForgotVerifyInput,
  LogoutInput,
  OtpVerifyInput,
  PasswordLoginInput,
  RefreshInput,
  ResetPasswordInput,
} from './auth.schema';

/** What `LOGIN_FAILURE_LOCK_THRESHOLD` is when a deployment sets nothing. */
const LOGIN_FAILURE_LOCK_DEFAULT = 10;
/**
 * The failure window is `RedisTtl.loginFailureWindow` (F-078). It used to be a
 * private 900 here, duplicating a catalogue entry that nothing imported — the
 * entry existed and only its own snapshot ever referenced it.
 */
const LOGIN_FAILURE_WINDOW_SEC = RedisTtl.loginFailureWindow;

/**
 * The three fields a 202 hands back (F-067-j).
 *
 * `deliveryId` reads the status; `channel` and `channelToken` hear the result
 * live. A client uses whichever it can and the two are not alternatives it has
 * to choose between — the socket is the fast path and the status is the record
 * (D-15), so a client that opened one and missed an event still reads the
 * other.
 *
 * Built in one place because three routes answer this shape and a fourth will;
 * a field added to two of them and forgotten in the third is the kind of drift
 * only a client discovers.
 */
function deliveryHandles(delivery: OtpDeliveryHandles) {
  return {
    deliveryId: delivery.deliveryId,
    channel: otpRealtimeChannel(delivery.channelId),
    channelToken: delivery.channelToken,
  };
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

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
    private readonly deliveries: OtpDeliveryStore,
  ) {}

  /**
   * How many failed passwords lock one account. Deployment config, not a
   * constant: read per call so an environment can vary it without a rebuild.
   */
  private get loginFailureLockThreshold(): number {
    return this.config.get<number>(
      'LOGIN_FAILURE_LOCK_THRESHOLD',
      LOGIN_FAILURE_LOCK_DEFAULT,
    );
  }

  /** The delivery methods this tenant offers, for a client to choose from. */
  async otpChannels() {
    return ok({ channels: await this.channels.describe() }, 'auth.otpChannels');
  }

  /**
   * What became of the send a 202 accepted (F-067-a).
   *
   * An id nobody minted, and one whose TTL has passed, both answer `queued` —
   * the same thing a code still sitting on the queue answers. That is
   * deliberate: the routes that mint an id do so whether or not a code was
   * really issued (`OtpDeliveryStore.newId`), and an answer that distinguished
   * "never queued" from "not delivered yet" would hand back the account
   * existence those routes refuse to state.
   */
  async otpDeliveryStatus(deliveryId: string) {
    const status = (await this.deliveries.read(deliveryId)) ?? {
      state: 'queued' as const,
    };
    return ok(status, 'auth.otpDeliveryStatus');
  }

  async loginWithPassword(
    input: PasswordLoginInput,
    ip: string,
    userAgent: string,
    lang: string,
    scopeKey?: string | null,
  ) {
    return safeExecute(async () => {
      const type = detectIdentifierType(input.identifier);
      // One account is one lock. The lookup normalizes a phone number, so the
      // failure counter has to be keyed on the same normalized value: keying
      // it on the raw input would give `09...`, `+989...` and `00989...` a
      // counter each, and ten attempts would become thirty.
      const identity =
        type === 'phone'
          ? normalizePhone(input.identifier)
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

      const failureBucket = rateLimitBucketKey(
      RateLimitBucket.LOGIN_FAILURES,
      identity,
    );
      const attempt = await this.rateLimiter.hit(
        failureBucket,
        this.loginFailureLockThreshold,
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
        const channel = await this.resolveOtpChannel(user);
        const delivery = await this.deliveries.mintHandles();
        await this.otp.issueOtp(
          user.phoneNumber!,
          OtpPurpose.login,
          channel,
          ip,
          lang,
          delivery,
        );
        const otpToken = this.tokens.signOtpToken(user.id);
        return ok(
          { requiresOtp: true, otpToken, ...deliveryHandles(delivery) },
          'auth.otpSent',
        );
      }

      const sessionData = await this.issueSession(user, ip, userAgent, scopeKey);
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
      const user = await this.prisma.user.findFirst({
        where: { phoneNumber },
        select: {
          id: true,
          status: true,
          phoneVerifiedAt: true,
          preferredOtpChannel: true,
        },
      });
      const resolvedChannel = await this.resolveOtpChannel(user ?? {}, channel);

      const link = await this.linkIfNeeded(
        resolvedChannel,
        phoneNumber,
        OtpPurpose.login,
        ip,
        lang,
      );
      if (link) return link;

      // Minted whether or not a code is issued: handles handed out only for a
      // real account would answer the question `{accepted:true}` exists to
      // refuse, and the channel would answer it a second time by accepting or
      // refusing a subscription (`OtpDeliveryStore.mintHandles`).
      const delivery = await this.deliveries.mintHandles();
      if (user?.status === 'active' && user.phoneVerifiedAt) {
        await this.otp.issueOtp(
          phoneNumber,
          OtpPurpose.login,
          resolvedChannel,
          ip,
          lang,
          delivery,
        );
      }
      return ok(
        { accepted: true, ...deliveryHandles(delivery) },
        'auth.otpSent',
      );
    });
  }

  async verifyLoginOtp(
    input: OtpVerifyInput,
    ip: string,
    userAgent: string,
    scopeKey?: string | null,
  ) {
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
        const sessionData = await this.issueSession(user, ip, userAgent, scopeKey);
        return ok(sessionData, 'auth.loginSuccess');
      }

      if (!input.phoneNumber) return err('auth.phoneNumberRequired');
      const user = await this.prisma.user.findFirst({
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
      const sessionData = await this.issueSession(user, ip, userAgent, scopeKey);
      return ok(sessionData, 'auth.loginSuccess');
    });
  }

  /**
   * Read-only "does this refresh token still mean anything?".
   *
   * Deliberately separate from {@link refresh}: refreshing *rotates*, so it
   * revokes the caller's session and mints a new one. Anything that only wants
   * to know whether a visitor is signed in — `panel-web`'s proxy does, before
   * it renders an auth screen (F-0101) — must not pay that price. Asking
   * `refresh` that question left the browser holding a token the rotation had
   * already revoked whenever the rotated `Set-Cookie` did not land (an RSC
   * prefetch of the same route, a discarded redirect response, a second request
   * already in flight with the old cookie), and the next real refresh then
   * signed the user out with the cookie still sitting in the browser.
   *
   * Postgres is the record (identity/invariants.md #8), so this asks Postgres
   * and never the Redis liveness cache.
   */
  async sessionStatus(
    refreshToken: string | undefined,
  ): Promise<ResponseType<{ active: boolean }>> {
    // `safeExecute` passes an envelope through at runtime but types the result
    // as `ResponseType<SuccessResponse<…>>`, so the annotation above is what
    // lets the controller read `data.active` without reaching through a second
    // `data`. The cast describes what safeExecute actually returns here.
    return safeExecute(async () => {
      if (!refreshToken) return ok({ active: false }, 'auth.sessionInactive');
      const session = await this.prisma.session.findUnique({
        where: { refreshTokenHash: this.tokens.refreshHash(refreshToken) },
        select: { revokedAt: true, expiresAt: true },
      });
      const active = Boolean(
        session && !session.revokedAt && session.expiresAt > new Date(),
      );
      return ok(
        { active },
        active ? 'auth.sessionActive' : 'auth.sessionInactive',
      );
    }) as Promise<ResponseType<{ active: boolean }>>;
  }

  async refresh(input: RefreshInput, ip: string, userAgent: string) {
    return safeExecute(async () => {
      if (!input.refreshToken) return err('auth.refreshTokenRequired');
      const session = await this.prisma.session.findUnique({
        where: {
          refreshTokenHash: this.tokens.refreshHash(input.refreshToken),
        },
      });
      if (!session || session.revokedAt || session.expiresAt <= new Date()) {
        return err('auth.invalidRefreshToken');
      }

      // Read as its own query rather than `include`d on the session above,
      // and the reason is RLS, not style. `identity.user` carries the
      // `tenantId = current_tenant_id()` policy and `identity.session` carries
      // none, so the two tables answer to different rules in one statement.
      // The setting that policy reads is bound by the tenant extension, which
      // hooks `TENANT_SCOPED_MODELS` as the **top-level** model of a query
      // (`tenant-context/with-tenant.ts`) — a join reached from `session` never
      // passes through it. Unbound, Postgres filtered the joined row away,
      // Prisma found a required relation missing and threw
      // `Inconsistent query result`, and that 500 is what the panel read as
      // "not signed in" on every dashboard load.
      //
      // Null here is now a real answer rather than a crash: the session exists
      // but its user is not visible in this request's tenant scope. Refusing
      // is right — a session belongs to the tenant it was minted in.
      const user = await this.prisma.user.findUnique({
        where: { id: session.userId },
        include: {
          role: {
            include: { rolePermissions: { include: { permission: true } } },
          },
        },
      });
      if (!user) return err('auth.invalidRefreshToken');

      await this.sessionService.revokeSession(session.id, 'user_logout');
      const result = await this.sessionService.createSession(
        session.userId,
        // A session that observed no device observes none on rotation either
        // (F-048): the refresh arrives over the same path the mint did, so
        // re-deriving here would write the bot container's address over the
        // honest null within one access-token lifetime. A browser's IP is
        // re-read as before — it legitimately moves.
        session.ipAddress === null ? null : ip,
        session.userAgent === null ? null : userAgent,
        // Carried forward, never re-derived from the request (ADR-0015). A
        // refresh is the *same* session continuing, so it stays in the scope
        // it was minted in — and the panel refreshes on every page load, so
        // re-deriving here would silently move a session to a new scope the
        // moment anything about the request changed. Re-minting it as `null`
        // would be worse still: the account would quietly fall out of its own
        // switch group on the first rotation.
        //
        // `deviceLabel` rides along for the same reason: the surface a session
        // was minted on does not change when its token does.
        { scopeKey: session.scopeKey, deviceLabel: session.deviceLabel },
      );
      const accessToken = this.tokens.signAccessToken(
        user,
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
        select: { id: true, userId: true, scopeKey: true },
      });
      if (!session) return ok({ success: true }, 'auth.logoutSuccess');

      // ADR-0033: signing out is a statement about the **place**, not about
      // the one token that carried the request. A place can hold more than one
      // session for the same account — a bot chat and its Mini App are one
      // place (ADR-0032) and hold two — and revoking only the caller's left the
      // chat signed in after a Mini App logout, which is not what "log out"
      // means to anyone.
      //
      // The scope comes off the row the token resolved to, never off the
      // request: this route is public (it reads a cookie, not a Bearer), so the
      // request cannot be trusted to name the place it is signing out of.
      //
      // A session with no scope — impersonation, or anything minted before
      // ADR-0015 — matches no place, so it falls back to revoking itself.
      if (!session.scopeKey) {
        await this.sessionService.revokeSession(session.id, 'user_logout');
        return ok({ success: true }, 'auth.logoutSuccess');
      }

      await this.sessionService.revokeSessionsForUserInScope(
        session.userId,
        session.scopeKey,
        'user_logout',
      );

      // ADR-0035: a place that still holds another account the user already
      // proved does not go dark — it falls back onto it. This grants nothing
      // new: being signed in as the outgoing account already carried the right
      // to become any member with no credential (`F-0207`), so the fallback is
      // a switch the user could have made a moment earlier by hand.
      //
      // Leaving the place entirely is `logoutEverywhere`, deliberately its own
      // action rather than a mode of this one.
      const fallback = await this.fallbackMember(
        session.scopeKey,
        session.userId,
      );
      if (!fallback) return ok({ success: true }, 'auth.logoutSuccess');

      try {
        const tokens = await this.createSessionForUser(
          fallback.user,
          null,
          null,
          session.scopeKey,
        );
        await this.prisma.linkedAccountGroup.update({
          where: { id: fallback.groupId },
          data: { actingAsUserId: fallback.user.id },
        });
        return ok(
          {
            success: true,
            switchedTo: {
              userId: fallback.user.id,
              fullName: fallback.user.fullName,
            },
            ...tokens,
          },
          'auth.logoutSwitched',
        );
      } catch (error) {
        // The revoke already happened, so the one thing this must not become
        // is a 500. "You are logged out" is true and complete on its own;
        // coming back up as someone else is the part that failed.
        this.logger.error(
          `logout: signed ${session.userId} out of ${session.scopeKey}, but the fallback onto ${fallback.user.id} failed: ${
            (error as Error)?.message ?? error
          }`,
        );
        return ok({ success: true }, 'auth.logoutSuccess');
      }
    });
  }

  /**
   * Sign out of **every** account this place holds (ADR-0035).
   *
   * The deliberate one. Ordinary logout falls back onto the group, which is
   * right for "I am done with this account" and wrong for "I am handing this
   * device over" — so that second intention gets its own route rather than
   * being a checkbox on the first.
   *
   * It signs out; it does not un-prove. The group's membership rows stand, so
   * signing back in and switching costs no new OTP. Taking an account out of
   * the place is `F-0208`.
   */
  async logoutEverywhere(input: LogoutInput) {
    return safeExecute(async () => {
      if (!input.refreshToken)
        return ok({ success: true }, 'auth.logoutSuccess');
      const session = await this.prisma.session.findUnique({
        where: {
          refreshTokenHash: this.tokens.refreshHash(input.refreshToken),
        },
        select: { id: true, userId: true, scopeKey: true },
      });
      if (!session) return ok({ success: true }, 'auth.logoutSuccess');

      if (!session.scopeKey) {
        await this.sessionService.revokeSession(session.id, 'user_logout');
        return ok({ success: true }, 'auth.logoutSuccess');
      }

      const membership = await this.prisma.linkedAccountMember.findUnique({
        where: {
          scopeKey_userId: {
            scopeKey: session.scopeKey,
            userId: session.userId,
          },
        },
        select: { groupId: true },
      });

      const members = membership
        ? await this.prisma.linkedAccountMember.findMany({
            where: { scopeKey: session.scopeKey, groupId: membership.groupId },
            select: { userId: true },
          })
        : [{ userId: session.userId }];

      // The caller's own is in there when a group exists, and added here when
      // it does not — an account with no group still has to be signed out.
      const userIds = new Set(members.map((m) => m.userId));
      userIds.add(session.userId);

      for (const userId of userIds) {
        await this.sessionService.revokeSessionsForUserInScope(
          userId,
          session.scopeKey,
          'user_logout',
        );
      }

      if (membership) {
        // The place is nobody now. Without this, the next implicit sign-in
        // would come back up as whoever it was last acting as (ADR-0034) —
        // which is the opposite of what this route was reached for.
        await this.prisma.linkedAccountGroup.update({
          where: { id: membership.groupId },
          data: { actingAsUserId: null },
        });
      }

      return ok({ success: true }, 'auth.logoutSuccess');
    });
  }

  /**
   * Who this place falls back onto when `outgoingUserId` signs out.
   *
   * **The oldest remaining member**, so the answer never depends on row order
   * or on which account was most recently touched: a group of three signs out
   * into the same account every time, and in a bot chat that is normally the
   * account the chat was linked with.
   *
   * `null` — no group here, nobody else in it, or nobody left who could hold a
   * session — is not an error. It is an ordinary full logout.
   */
  private async fallbackMember(scopeKey: string, outgoingUserId: string) {
    const membership = await this.prisma.linkedAccountMember.findUnique({
      where: { scopeKey_userId: { scopeKey, userId: outgoingUserId } },
      select: { groupId: true },
    });
    if (!membership) return null;

    const members = await this.prisma.linkedAccountMember.findMany({
      where: { scopeKey, groupId: membership.groupId },
      select: { userId: true, addedAt: true },
    });

    const candidates = members
      .filter((m) => m.userId !== outgoingUserId)
      .sort((a, b) => a.addedAt.getTime() - b.addedAt.getTime());

    for (const candidate of candidates) {
      // The same conditions any sign-in applies. A suspended or deleted member
      // is skipped rather than refused — the next one may be fine, and if none
      // is, the place is simply signed out.
      const user = await this.findUserForSession(candidate.userId);
      if (!user || user.deletedAt || user.status !== 'active') continue;
      return { user, groupId: membership.groupId };
    }
    return null;
  }

  async forgotPassword(input: ForgotPasswordInput, ip: string, lang: string) {
    return safeExecute(async () => {
      const user = await this.prisma.user.findFirst({
        where: { phoneNumber: input.phoneNumber },
        select: { id: true, status: true, preferredOtpChannel: true },
      });
      const channel = await this.resolveOtpChannel(user ?? {}, input.channel);

      const link = await this.linkIfNeeded(
        channel,
        input.phoneNumber,
        OtpPurpose.password_reset,
        ip,
        lang,
      );
      if (link) return link;

      const delivery = await this.deliveries.mintHandles();
      if (user?.status === 'active') {
        await this.otp.issueOtp(
          input.phoneNumber,
          OtpPurpose.password_reset,
          channel,
          ip,
          lang,
          delivery,
        );
      }
      return ok(
        { accepted: true, ...deliveryHandles(delivery) },
        'auth.resetOtpSent',
      );
    });
  }

  async verifyForgotPassword(input: ForgotVerifyInput) {
    return safeExecute(async () => {
      await this.otp.verifyOtp(
        input.phoneNumber,
        OtpPurpose.password_reset,
        input.otpCode,
      );
      const user = await this.prisma.user.findFirst({
        where: { phoneNumber: input.phoneNumber },
        select: { id: true },
      });
      if (!user) return err('auth.invalidResetRequest');
      const resetToken = this.tokens.signResetToken(input.phoneNumber, user.id);
      return ok({ resetToken }, 'auth.resetTokenGenerated');
    });
  }

  async resetPassword(
    input: ResetPasswordInput,
    ip: string,
    userAgent: string,
    scopeKey?: string | null,
  ) {
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
      const sessionData = await this.issueSession(full, ip, userAgent, scopeKey);

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

  // --- proof of account ownership, for `audit`'s account-switch group -------
  //
  // These three are identity's half of F-0205. The *rule* about who may join a
  // switch group is `audit`'s and lives there; what identity owes it is the
  // narrow question "does this credential actually belong to that account?".
  // They are here rather than duplicated in `audit` because the answer depends
  // on the same lockout counter, the same normalization and the same
  // enumeration-safe answer ordering as login does (rules #11, #12), and a
  // second implementation of that ordering is a second thing to get wrong.
  //
  // Unlike login they mint nothing: no session, no token, no cookie. The caller
  // gets a user row or null, and decides what that is worth.

  /**
   * Does `identifier` + `password` name a live, phone-verified account?
   *
   * Deliberately one answer for every failure — wrong password, no such
   * account, deleted, inactive, unverified phone all return `null`. A caller
   * holding one session must not be able to use this route to learn which
   * numbers are registered (invariant #6's reasoning, applied to a caller who
   * has proven only *their own* identity).
   */
  async proveAccountByPassword(identifier: string, password: string) {
    const type = detectIdentifierType(identifier);
    const identity =
      type === 'phone' ? normalizePhone(identifier) : identifier;
    const where =
      type === 'phone' ? { phoneNumber: identity } : { username: identity };

    const user = await this.prisma.user.findFirst({ where });
    if (!user || user.deletedAt || user.status !== 'active') return null;

    // The same bucket login uses, on purpose: this route is another way to
    // guess a password, so it has to consume the same budget or it becomes the
    // cheaper door (rule #11) — including when a deployment has changed it.
    //
    // It used to be spelled by hand here and at the login site, with this
    // comment between them saying they had to stay identical and nothing
    // making them. Both now name the same registry entry, so they cannot
    // diverge without a compile error (F-077, C-05).
    const failureBucket = rateLimitBucketKey(
      RateLimitBucket.LOGIN_FAILURES,
      identity,
    );
    const attempt = await this.rateLimiter.hit(
      failureBucket,
      this.loginFailureLockThreshold,
      LOGIN_FAILURE_WINDOW_SEC,
    );
    if (!attempt.allowed) throw new BadRequestException('auth.temporarilyLocked');

    if (!(await argon2.verify(user.passwordHash, password))) return null;
    await this.rateLimiter.reset(failureBucket);

    if (!user.phoneVerifiedAt) return null;
    return user;
  }

  /**
   * Send a proof code to `phoneNumber` on a channel that account can receive.
   *
   * Returns the `linkRequired` deep-link shape when the chosen messenger is not
   * connected yet, exactly as login does — the caller has already proven a
   * session, but the *target* account has proven nothing, so it gets the same
   * enumeration-safe treatment: an unknown or inactive number is accepted and
   * nothing is sent.
   */
  async issueAccountProofOtp(
    phoneNumber: string,
    channel: OtpChannel | undefined,
    ip: string,
    lang: string,
  ) {
    const user = await this.prisma.user.findFirst({
      where: { phoneNumber },
      select: { status: true, phoneVerifiedAt: true, preferredOtpChannel: true },
    });
    const resolvedChannel = await this.resolveOtpChannel(user ?? {}, channel);

    const link = await this.linkIfNeeded(
      resolvedChannel,
      phoneNumber,
      OtpPurpose.account_switch_link,
      ip,
      lang,
    );
    if (link) return link;

    if (user?.status === 'active' && user.phoneVerifiedAt) {
      await this.otp.issueOtp(
        phoneNumber,
        OtpPurpose.account_switch_link,
        resolvedChannel,
        ip,
        lang,
        // Minted and never handed out: this route answers `{accepted:true}`
        // and nothing else (`auth-api/contract.md`), so nobody can subscribe
        // to the channel and it simply expires. The handles exist because
        // `issueOtp` records a delivery status for every send, and a send with
        // no status would be the one the fallback cannot answer for.
        await this.deliveries.mintHandles(),
      );
    }
    return null;
  }

  /**
   * Consume a proof code and return the account it proves, or `null`.
   *
   * `account_switch_link` is its own `OtpPurpose` so that a code minted here
   * can never be spent as a login and vice versa — invariant #10 allows one
   * active code per (phone, purpose), and sharing a purpose with login would
   * mean adding an account silently destroys a login code the same person is
   * mid-way through typing.
   */
  async proveAccountByOtp(phoneNumber: string, otpCode: string) {
    const user = await this.prisma.user.findFirst({ where: { phoneNumber } });
    if (!user || user.deletedAt || user.status !== 'active') return null;
    if (!user.phoneVerifiedAt) return null;
    if (
      !(await this.otp.verifyOtp(
        phoneNumber,
        OtpPurpose.account_switch_link,
        otpCode,
      ))
    ) {
      return null;
    }
    return user;
  }

  async createSessionForUser(
    user: any,
    ip: string | null,
    userAgent: string | null,
    scopeKey?: string | null,
    deviceLabel?: string | null,
  ) {
    return this.issueSession(user, ip, userAgent, scopeKey, deviceLabel);
  }

  /**
   * Hand a browser from one session to another (F-0207).
   *
   * `audit` decides *whether* the switch is allowed — that is the membership
   * rule and it lives there. What identity owes it is this: the two session
   * writes happening as one, because they are the two halves of a single
   * statement about how many live sessions this browser has (audit invariant
   * #7, C-21). No credential is checked here; the caller has already proven
   * the target is theirs, once, when it joined the group.
   *
   * Order matters, and it is not the obvious one:
   *
   * 1. the transaction revokes the outgoing row and writes the incoming one —
   *    either both land or neither does;
   * 2. *then* the outgoing Redis marker is dropped;
   * 3. *then* the incoming marker is written.
   *
   * `AuthGuard` reads only the marker, so between (1) and (3) the browser
   * briefly has no usable session and never two. Writing the incoming marker
   * first would open the opposite window — two live sessions — which is the
   * one state F-0101 says cannot exist.
   */
  async switchSession(
    fromSessionId: string,
    fromUserId: string,
    toUser: any,
    ip: string,
    userAgent: string,
    scopeKey?: string | null,
  ) {
    const issued = await this.prisma.$transaction(async (tx) => {
      const outgoing = await tx.session.update({
        where: { id: fromSessionId },
        data: {
          revokedAt: new Date(),
          revokedReason: SessionRevokedReason.account_switched,
        },
        select: { ipAddress: true, userAgent: true, deviceLabel: true },
      });
      return this.sessionService.createSession(
        toUser.id,
        // The switch is made on the surface the outgoing session was minted
        // on, so its device facts are the incoming session's too (F-048). A
        // switch inside a chat would otherwise re-stamp the bot container's
        // address, which is the lie the null exists to stop.
        outgoing.ipAddress === null ? null : ip,
        outgoing.userAgent === null ? null : userAgent,
        {
          switchedFromUserId: fromUserId,
          // A switch happens *within* one scope — `audit` only offered this
          // member because it is in the caller's group here — so the incoming
          // session inherits it (ADR-0015).
          scopeKey,
          deviceLabel: outgoing.deviceLabel,
          tx,
        },
      );
    });

    await this.sessions.drop(fromSessionId, fromUserId);
    await issued.activateCache();

    return {
      accessToken: this.tokens.signAccessToken(toUser, issued.session.id),
      refreshToken: issued.refreshToken,
      expiresIn: this.config.get<number>('JWT_ACCESS_TTL_SEC', 900),
    };
  }

  /**
   * The one place an ordinary session is minted, and therefore the one place
   * `scopeKey` has to be stamped (ADR-0015). Every caller passes the scope the
   * request arrived on; a session that was minted with none simply belongs to
   * no switch group, which is a legitimate state, not an error.
   */
  private async issueSession(
    user: any,
    ip: string | null,
    userAgent: string | null,
    scopeKey?: string | null,
    deviceLabel?: string | null,
  ) {
    const result = await this.sessionService.createSession(
      user.id,
      ip,
      userAgent,
      { scopeKey, deviceLabel },
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
    await this.channels.assertUsable(channel);

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
  private async resolveOtpChannel(
    user: { preferredOtpChannel?: OtpChannel | null },
    explicitChannel?: OtpChannel,
  ): Promise<OtpChannel> {
    // An explicitly named channel is never silently swapped: if it is off,
    // OtpService/linkIfNeeded rejects the request so the client can say why.
    if (explicitChannel) return explicitChannel;
    if (
      user.preferredOtpChannel &&
      (await this.channels.isAvailable(user.preferredOtpChannel))
    ) {
      return user.preferredOtpChannel;
    }
    const fallback = await this.channels.defaultChannel();
    if (!fallback) throw new BadRequestException('otp.noChannelAvailable');
    return fallback;
  }
}
