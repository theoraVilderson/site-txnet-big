/**
 * A client that talks to the API the way `panel-web` does: it keeps the
 * `refresh_token` cookie the way a browser would, and it walks the captcha
 * challenge before every gated call.
 *
 * Specs use it so a flow reads as a flow. Where a spec is about the gate
 * itself, it passes `captcha: null` (send nothing) or a token of its own and
 * goes through the raw helpers.
 */
import request from 'supertest';
import type { Server } from 'node:http';

/** Long enough to clear CaptchaService's MIN_INTERACTION_MS human check. */
const SLIDE_MS = 300;

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export type CaptchaArg = 'auto' | string | null;

export interface CallOptions {
  captcha?: CaptchaArg;
  bearer?: string;
  acceptLanguage?: string;
  headers?: Record<string, string>;
}

export interface Cookie {
  value: string;
  attributes: Record<string, string | true>;
}

export function parseSetCookie(
  raw: string | string[] | undefined,
  name: string,
): Cookie | undefined {
  const all = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const line = all.find((c) => c.startsWith(`${name}=`));
  if (!line) return undefined;
  const [pair, ...rest] = line.split(';');
  const attributes: Record<string, string | true> = {};
  for (const part of rest) {
    const [key, ...value] = part.trim().split('=');
    attributes[key.toLowerCase()] = value.length ? value.join('=') : true;
  }
  return { value: decodeURIComponent(pair.slice(name.length + 1)), attributes };
}

export class AuthApi {
  private cookies = new Map<string, string>();

  constructor(private readonly server: Server) {}

  // --- cookie jar -----------------------------------------------------------

  cookie(name: string): string | undefined {
    return this.cookies.get(name);
  }

  get refreshCookie(): string | undefined {
    return this.cookies.get('refresh_token');
  }

  /** Adopt a cookie jar entry by hand (e.g. to replay an old token). */
  setCookie(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  clearCookies(): void {
    this.cookies.clear();
  }

  private absorb(res: request.Response): request.Response {
    // supertest types every header as a string; Set-Cookie is the one that
    // really arrives as an array.
    const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
    for (const line of raw ?? []) {
      const name = line.slice(0, line.indexOf('='));
      const parsed = parseSetCookie(raw, name);
      if (!parsed) continue;
      const expires = parsed.attributes['expires'];
      const expired =
        parsed.value === '' ||
        (typeof expires === 'string' && new Date(expires).getTime() <= Date.now());
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, parsed.value);
    }
    return res;
  }

  private cookieHeader(): string | undefined {
    if (this.cookies.size === 0) return undefined;
    return [...this.cookies].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
  }

  // --- transport ------------------------------------------------------------

  async post(
    path: string,
    body?: unknown,
    options: CallOptions = {},
  ): Promise<request.Response> {
    let call = request(this.server).post(`/api${path}`);
    call = this.decorate(call, options);
    const res = await (body === undefined ? call.send() : call.send(body as object));
    return this.absorb(res);
  }

  async get(path: string, options: CallOptions = {}): Promise<request.Response> {
    const res = await this.decorate(request(this.server).get(`/api${path}`), options);
    return this.absorb(res);
  }

  private decorate(call: request.Test, options: CallOptions): request.Test {
    const cookie = this.cookieHeader();
    if (cookie) call = call.set('Cookie', cookie);
    if (options.bearer) call = call.set('Authorization', `Bearer ${options.bearer}`);
    if (options.acceptLanguage) call = call.set('Accept-Language', options.acceptLanguage);
    for (const [key, value] of Object.entries(options.headers ?? {})) {
      call = call.set(key, value);
    }
    return call;
  }

  /** A gated POST: solves a captcha unless the caller supplied or refused one. */
  private async gated(
    path: string,
    body: unknown,
    options: CallOptions,
  ): Promise<request.Response> {
    // `null` is the caller saying "send no pass at all" — distinct from
    // omitting the option, which means "solve one for me".
    const arg = options.captcha === undefined ? 'auto' : options.captcha;
    const token = arg === 'auto' ? await this.solveCaptcha() : arg;
    return this.post(path, body, {
      ...options,
      headers: {
        ...(options.headers ?? {}),
        ...(token ? { 'X-Captcha-Token': token } : {}),
      },
    });
  }

  // --- routes ---------------------------------------------------------------

  async challenge(): Promise<request.Response> {
    return this.post('/auth/captcha/challenge');
  }

  async verifyChallenge(challengeId: string): Promise<request.Response> {
    return this.post('/auth/captcha/verify', { challengeId });
  }

  /** challenge -> wait out the human check -> verify, and hand back the pass. */
  async solveCaptcha(): Promise<string> {
    const issued = await this.challenge();
    if (!issued.body?.data?.challengeId) {
      throw new Error(
        `captcha challenge failed: ${issued.status} ${JSON.stringify(issued.body)}`,
      );
    }
    await sleep(SLIDE_MS);
    const verified = await this.verifyChallenge(issued.body.data.challengeId);
    if (!verified.body?.data?.token) {
      throw new Error(
        `captcha verify failed: ${verified.status} ${JSON.stringify(verified.body)}`,
      );
    }
    return verified.body.data.token as string;
  }

  register(body: unknown, options: CallOptions = {}) {
    return this.gated('/auth/register', body, options);
  }

  verifyPhone(body: unknown, options: CallOptions = {}) {
    return this.post('/auth/register/verify-phone', body, options);
  }

  login(body: unknown, options: CallOptions = {}) {
    return this.gated('/auth/login/password', body, options);
  }

  requestLoginOtp(body: unknown, options: CallOptions = {}) {
    return this.gated('/auth/login/otp/request', body, options);
  }

  verifyLoginOtp(body: unknown, options: CallOptions = {}) {
    return this.post('/auth/login/otp/verify', body, options);
  }

  otpChannels(options: CallOptions = {}) {
    return this.get('/auth/otp/channels', options);
  }

  refresh(body: unknown = {}, options: CallOptions = {}) {
    return this.post('/auth/refresh', body, options);
  }

  logout(body: unknown = {}, options: CallOptions = {}) {
    return this.post('/auth/logout', body, options);
  }

  forgotPassword(body: unknown, options: CallOptions = {}) {
    return this.gated('/auth/password/forgot', body, options);
  }

  forgotVerifyOtp(body: unknown, options: CallOptions = {}) {
    return this.post('/auth/password/forgot/verify-otp', body, options);
  }

  resetPassword(body: unknown, options: CallOptions = {}) {
    return this.post('/auth/password/reset', body, options);
  }

  // --- the switch group (F-0205 / F-0206 / F-0207) --------------------------
  //
  // None of these is captcha-gated and every one needs a Bearer: they are the
  // routes that require a live session rather than refusing one.

  listAccounts(options: CallOptions = {}) {
    return this.get('/auth/accounts', options);
  }

  addAccountOtpRequest(body: unknown, options: CallOptions = {}) {
    return this.post('/auth/accounts/add/otp/request', body, options);
  }

  addAccountOtpVerify(body: unknown, options: CallOptions = {}) {
    return this.post('/auth/accounts/add/otp/verify', body, options);
  }

  addAccountPassword(body: unknown, options: CallOptions = {}) {
    return this.post('/auth/accounts/add/password', body, options);
  }

  switchAccount(body: unknown, options: CallOptions = {}) {
    return this.post('/auth/accounts/switch', body, options);
  }
}
