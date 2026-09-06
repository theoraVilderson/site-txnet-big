import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotContact, BotPlatform } from '@txnet-backend/messenger';
import {
  AddAccountResult,
  ApiResult,
  BotLinkOutcome,
  BotLinkStatus,
  BotSessionResult,
  OtpChannelDescriptor,
  OtpRequestResult,
  PasswordLoginResult,
  RemoveAccountResult,
  SwitchGroup,
  SwitchResult,
  TokenPair,
} from './auth-api.types';

/**
 * The only way out of `bot-app`.
 *
 * Every rule the bot appears to have is really an `auth-api` answer: this class
 * exists so that stays true by construction (ADR-0009). It calls the same
 * routes `panel-web` calls, adds the service credential that stands in for the
 * captcha (ADR-0011), and never inspects a status code — `ok` is the answer.
 */
@Injectable()
export class AuthApiClient {
  private readonly logger = new Logger(AuthApiClient.name);
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.baseUrl = config
      .get<string>('AUTH_API_BASE_URL', '')
      .replace(/\/+$/, '');
    this.serviceToken = config.get<string>('SERVICE_AUTH_TOKEN', '');
    this.timeoutMs = config.get<number>('AUTH_API_TIMEOUT_MS', 8000);
  }

  // --- discovery ----------------------------------------------------------

  otpChannels(ctx: CallContext): Promise<ApiResult<{ channels: OtpChannelDescriptor[] }>> {
    return this.call('GET', '/api/auth/otp/channels', undefined, ctx);
  }

  // --- login --------------------------------------------------------------

  requestLoginOtp(
    body: { phoneNumber: string; channel?: string },
    ctx: CallContext,
  ): Promise<ApiResult<OtpRequestResult>> {
    return this.call('POST', '/api/auth/login/otp/request', body, ctx);
  }

  verifyLoginOtp(
    body: { phoneNumber: string; otpCode: string },
    ctx: CallContext,
  ): Promise<ApiResult<TokenPair>> {
    return this.call('POST', '/api/auth/login/otp/verify', body, ctx);
  }

  loginWithPassword(
    body: { identifier: string; password: string },
    ctx: CallContext,
  ): Promise<ApiResult<PasswordLoginResult>> {
    return this.call('POST', '/api/auth/login/password', body, ctx);
  }

  // --- registration -------------------------------------------------------

  register(
    body: {
      fullName: string;
      username: string;
      phoneNumber: string;
      password: string;
      channel?: string;
    },
    ctx: CallContext,
  ): Promise<ApiResult<OtpRequestResult & { requiresPhoneVerification: boolean }>> {
    return this.call('POST', '/api/auth/register', body, ctx);
  }

  verifyPhone(
    body: { phoneNumber: string; otpCode: string },
    ctx: CallContext,
  ): Promise<ApiResult<TokenPair>> {
    return this.call('POST', '/api/auth/register/verify-phone', body, ctx);
  }

  // --- password reset -----------------------------------------------------

  forgotPassword(
    body: { phoneNumber: string; channel?: string },
    ctx: CallContext,
  ): Promise<ApiResult<OtpRequestResult>> {
    return this.call('POST', '/api/auth/password/forgot', body, ctx);
  }

  verifyForgotOtp(
    body: { phoneNumber: string; otpCode: string },
    ctx: CallContext,
  ): Promise<ApiResult<{ resetToken: string }>> {
    return this.call('POST', '/api/auth/password/forgot/verify-otp', body, ctx);
  }

  resetPassword(
    body: { resetToken: string; newPassword: string },
    ctx: CallContext,
  ): Promise<ApiResult<TokenPair & { success: boolean }>> {
    return this.call('POST', '/api/auth/password/reset', body, ctx);
  }

  // --- session ------------------------------------------------------------

  refresh(
    body: { refreshToken: string },
    ctx: CallContext,
  ): Promise<ApiResult<TokenPair>> {
    return this.call('POST', '/api/auth/refresh', body, ctx);
  }

  logout(
    body: { refreshToken: string },
    ctx: CallContext,
  ): Promise<ApiResult<{ success: boolean }>> {
    return this.call('POST', '/api/auth/logout', body, ctx);
  }

  // --- the caller's own accounts (the rule stays in audit) -----------------

  /**
   * The switch group this chat's account belongs to (`F-0206`), and becoming
   * another member of it (`F-0207`).
   *
   * Both are behind `AuthGuard`, so unlike every other call on this class they
   * need the *user's* access token rather than only the service credential:
   * `audit` answers "whose group is this?" from the token, and there is no
   * other way to ask. `ChatAccess` mints one from the chat's stored refresh
   * token.
   */
  listAccounts(ctx: CallContext): Promise<ApiResult<SwitchGroup>> {
    return this.call('GET', '/api/auth/accounts', undefined, ctx);
  }

  switchAccount(
    body: { userId: string },
    ctx: CallContext,
  ): Promise<ApiResult<SwitchResult>> {
    return this.call('POST', '/api/auth/accounts/switch', body, ctx);
  }

  /**
   * Adding an account to that group (`F-0205`), by a code sent to its own
   * phone or by its own password.
   *
   * Also behind `AuthGuard`, and for a second reason on top of `listAccounts`':
   * the caller's live session is one half of the proof (`audit` invariant #4),
   * so a call without the user's access token is not a weaker version of this
   * one — it is a different, unproved thing that `auth-api` refuses.
   *
   * None of the three mints a session. The chat stays signed in as whoever it
   * was; the new account becomes reachable through `switchAccount`.
   */
  requestAddOtp(
    body: { phoneNumber: string; channel?: string },
    ctx: CallContext,
  ): Promise<ApiResult<OtpRequestResult>> {
    return this.call('POST', '/api/auth/accounts/add/otp/request', body, ctx);
  }

  addAccountByOtp(
    body: { phoneNumber: string; otpCode: string },
    ctx: CallContext,
  ): Promise<ApiResult<AddAccountResult>> {
    return this.call('POST', '/api/auth/accounts/add/otp/verify', body, ctx);
  }

  addAccountByPassword(
    body: { identifier: string; password: string },
    ctx: CallContext,
  ): Promise<ApiResult<AddAccountResult>> {
    return this.call('POST', '/api/auth/accounts/add/password', body, ctx);
  }

  /**
   * Take an account back out of this chat's group (`F-0208`).
   *
   * Removes it *here* and nowhere else — the same account may still be in a
   * group in the user's browser, and this call does not touch it (ADR-0015).
   * `userId` may be the chat's own account, which is how it leaves.
   */
  removeAccount(
    body: { userId: string },
    ctx: CallContext,
  ): Promise<ApiResult<RemoveAccountResult>> {
    return this.call('POST', '/api/auth/accounts/remove', body, ctx);
  }

  // --- account linking (the rule stays in identity) ------------------------

  linkResolve(
    body: {
      platform: BotPlatform;
      chatId: string;
      startToken?: string;
      languageCode?: string;
    },
    ctx: CallContext,
  ): Promise<ApiResult<BotLinkOutcome>> {
    return this.call('POST', '/api/auth/bots/link/resolve', body, ctx);
  }

  linkContact(
    body: {
      platform: BotPlatform;
      chatId: string;
      senderId: string | number;
      contact: BotContact;
    },
    ctx: CallContext,
  ): Promise<ApiResult<BotLinkOutcome>> {
    return this.call('POST', '/api/auth/bots/link/contact', body, ctx);
  }

  /**
   * Trade this chat's proven link for a session — no phone typed, no code
   * (ADR-0012). A chat with no link yet answers `needsContact`, and the same
   * call with the contact card attached both links and signs in.
   */
  botSession(
    body: {
      platform: BotPlatform;
      chatId: string;
      senderId?: string | number;
      contact?: BotContact;
    },
    ctx: CallContext,
  ): Promise<ApiResult<BotSessionResult>> {
    return this.call('POST', '/api/auth/bots/session', body, ctx);
  }

  linkStatus(
    body: { linkToken: string },
    ctx: CallContext,
  ): Promise<ApiResult<BotLinkStatus>> {
    return this.call('POST', '/api/auth/bots/link/status', body, ctx);
  }

  // --- transport ----------------------------------------------------------

  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    ctx: CallContext,
  ): Promise<ApiResult<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          'accept-language': ctx.lang,
          'x-service-token': this.serviceToken,
          'x-bot-chat-id': ctx.chatId,
          // The other half of the chat's identity (ADR-0015). Sent on every
          // call rather than only the account ones: it costs a header, and a
          // per-route rule about which calls carry it is exactly the kind of
          // thing that is right when written and wrong six months later.
          ...(ctx.platform ? { 'x-bot-platform': ctx.platform } : {}),
          // Only the routes behind `AuthGuard` carry one. The service token
          // says which service is calling; this says on whose behalf.
          ...(ctx.accessToken
            ? { authorization: `Bearer ${ctx.accessToken}` }
            : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch (e: unknown) {
      // A network failure is not a business answer: it becomes `ok: false`
      // with the generic key, so every caller has exactly one failure shape.
      this.logger.error(
        `auth-api ${method} ${path} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return { ok: false, msg: 'bot.common.tryAgain' };
    } finally {
      clearTimeout(timer);
    }

    let envelope: ApiResult<T>;
    try {
      envelope = (await response.json()) as ApiResult<T>;
    } catch {
      this.logger.error(
        `auth-api ${method} ${path} answered ${response.status} with a non-JSON body`,
      );
      return { ok: false, msg: 'bot.common.tryAgain' };
    }

    // auth-api strips the refresh token out of the body and sets it as an
    // httpOnly cookie for the browser. There is no browser here, so the bot
    // reads it back off the header and keeps it in its own session store.
    const refreshToken = readSetCookie(response, 'refresh_token');
    if (refreshToken && envelope.ok && envelope.data) {
      (envelope.data as { refreshToken?: string }).refreshToken = refreshToken;
    }

    return envelope;
  }
}

/** Who the call is for: the chat that pays the rate limit, in its language. */
export interface CallContext {
  chatId: string;
  lang: string;
  /**
   * Which messenger the chat is on. Required by every account route since
   * ADR-0015: a switch group belongs to one chat, and a chat is only
   * identified by `(platform, chatId)` — the two platforms number their chats
   * independently, so a chat id alone can name two different chats.
   *
   * `auth-api` refuses rather than assumes when it is missing, which is the
   * behaviour to want: a wrong guess here would merge two people's groups.
   */
  platform?: string;
  /** Set only for a route behind `AuthGuard` — see `listAccounts`. */
  accessToken?: string;
}

function readSetCookie(response: Response, name: string): string | undefined {
  // Node's fetch exposes multiple Set-Cookie headers through getSetCookie();
  // fall back to the joined value where that is not available.
  const raw: string[] =
    typeof (response.headers as { getSetCookie?: () => string[] }).getSetCookie ===
    'function'
      ? (response.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
      : [response.headers.get('set-cookie') ?? ''];

  for (const cookie of raw) {
    const match = new RegExp(`(?:^|,\\s*)${name}=([^;]+)`).exec(cookie);
    if (match) return decodeURIComponent(match[1]);
  }
  return undefined;
}
