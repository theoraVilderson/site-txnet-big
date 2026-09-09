import { ConfigService } from '@nestjs/config';
import { AuthApiClient, CallContext } from './auth-api.client';
import { BotCopy } from '../locale/bot-copy';

/**
 * Only the transport is tested here. Every method on this class is one line
 * over `call()`, and asserting that `login/otp/request` posts to
 * `/api/auth/login/otp/request` re-states the line above it. What `call()`
 * itself does is not visible anywhere else:
 *
 *   - it reads the refresh token off `Set-Cookie`, because auth-api strips it
 *     from the body for the browser and there is no browser here. Miss it and
 *     every bot login succeeds and then cannot be resumed;
 *   - a network failure and a non-JSON body both become the same `ok:false`
 *     envelope, so no caller ever has two failure shapes to handle — and its
 *     `msg` is a resolved sentence, because every caller renders `msg` as
 *     `BotText.raw`, which never goes through the translator again;
 *   - it never reads the status code — a business rejection arrives with a
 *     200 and `ok:false` (`auth-api/contract.md`).
 */

const env: Record<string, unknown> = {
  AUTH_API_BASE_URL: 'http://auth:3000/',
  SERVICE_AUTH_TOKEN: 'svc-token',
  AUTH_API_TIMEOUT_MS: 500,
};

const config = {
  get: <T>(key: string, fallback?: T) => (env[key] as T) ?? fallback,
} as unknown as ConfigService;

const ctx: CallContext = { chatId: '5501', lang: 'fa', platform: 'telegram' };

/** The sentence `bot.common.tryAgain` resolves to in `fa`. */
const TRY_AGAIN = 'یه مشکلی از سمت ما پیش اومد. لطفاً دوباره تلاش کنید.';

/** `BotCopy`, as far as the transport is concerned: a key in, a sentence out. */
const copy = {
  text: (lang: string, text: { key?: string }) =>
    lang === 'fa' && text.key === 'bot.common.tryAgain' ? TRY_AGAIN : `?${text.key}`,
} as unknown as BotCopy;

/** A fetch Response with a JSON body and optional Set-Cookie headers. */
function jsonResponse(
  body: unknown,
  { status = 200, cookies = [] as string[] } = {},
) {
  return {
    status,
    headers: {
      getSetCookie: () => cookies,
      get: (name: string) =>
        name.toLowerCase() === 'set-cookie' ? cookies.join(', ') : null,
    },
    json: async () => body,
  } as unknown as Response;
}

let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  jest.restoreAllMocks();
});

function client() {
  return new AuthApiClient(config, copy);
}

function lastRequest() {
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return { url: url as string, init: init as RequestInit };
}

describe('AuthApiClient transport', () => {
  it('builds the URL from the configured base with no doubled slash', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, msg: 'ok' }));

    await client().refresh({ refreshToken: 'r-1' }, ctx);

    expect(lastRequest().url).toBe('http://auth:3000/api/auth/refresh');
  });

  it('sends the service credential and the chat’s identity on every call', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, msg: 'ok' }));

    await client().refresh({ refreshToken: 'r-1' }, ctx);

    const headers = lastRequest().init.headers as Record<string, string>;
    expect(headers).toMatchObject({
      'content-type': 'application/json',
      'accept-language': 'fa',
      'x-service-token': 'svc-token',
      'x-bot-chat-id': '5501',
      'x-bot-platform': 'telegram',
    });
    // No user token on a route that is not behind AuthGuard.
    expect(headers.authorization).toBeUndefined();
  });

  it('sends the user’s access token only when one was supplied', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, msg: 'ok', data: {} }));

    await client().listAccounts({ ...ctx, accessToken: 'a-1' });

    const headers = lastRequest().init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer a-1');
  });

  it('omits the platform header rather than sending an empty one', async () => {
    // auth-api refuses rather than assumes when the platform is missing
    // (ADR-0015); an empty string would be a value, and a wrong one.
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, msg: 'ok' }));

    await client().refresh({ refreshToken: 'r-1' }, { chatId: '1', lang: 'fa' });

    const headers = lastRequest().init.headers as Record<string, string>;
    expect('x-bot-platform' in headers).toBe(false);
  });

  it('sends no body on a GET', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, msg: 'ok', data: {} }));

    await client().otpChannels(ctx);

    const { init } = lastRequest();
    expect(init.method).toBe('GET');
    expect('body' in init).toBe(false);
  });

  it('serialises the body on a POST', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, msg: 'ok' }));

    await client().loginWithPassword({ identifier: 'ada', password: 'p' }, ctx);

    const { init } = lastRequest();
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      identifier: 'ada',
      password: 'p',
    });
  });

  // --- the refresh cookie -------------------------------------------------

  it('lifts the refresh token out of Set-Cookie into the envelope', async () => {
    // Without this the bot logs in, gets an access token, and has nothing to
    // resume the session with fifteen minutes later.
    fetchMock.mockResolvedValue(
      jsonResponse(
        { ok: true, msg: 'ok', data: { accessToken: 'a-1', expiresIn: 900 } },
        {
          cookies: [
            'refresh_token=r-abc123; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=2592000',
          ],
        },
      ),
    );

    const res = await client().verifyLoginOtp(
      { phoneNumber: '09121112233', otpCode: '123456' },
      ctx,
    );

    expect(res.data).toMatchObject({ accessToken: 'a-1', refreshToken: 'r-abc123' });
  });

  it('url-decodes the cookie value', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { ok: true, msg: 'ok', data: { accessToken: 'a-1' } },
        { cookies: ['refresh_token=a%2Bb%3Dc; Path=/'] },
      ),
    );

    const res = await client().refresh({ refreshToken: 'old' }, ctx);

    expect((res.data as { refreshToken?: string }).refreshToken).toBe('a+b=c');
  });

  it('picks the refresh cookie out of several Set-Cookie headers', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { ok: true, msg: 'ok', data: { accessToken: 'a-1' } },
        {
          cookies: [
            'other=1; Path=/',
            'refresh_token=r-xyz; Path=/api/auth; HttpOnly',
            'another=2; Path=/',
          ],
        },
      ),
    );

    const res = await client().refresh({ refreshToken: 'old' }, ctx);

    expect((res.data as { refreshToken?: string }).refreshToken).toBe('r-xyz');
  });

  it('falls back to the joined header where getSetCookie is unavailable', async () => {
    // Not every runtime exposes getSetCookie; the fallback path has to find
    // the same cookie in a comma-joined header.
    fetchMock.mockResolvedValue({
      status: 200,
      headers: {
        get: () => 'other=1; Path=/, refresh_token=r-joined; HttpOnly',
      },
      json: async () => ({ ok: true, msg: 'ok', data: { accessToken: 'a-1' } }),
    } as unknown as Response);

    const res = await client().refresh({ refreshToken: 'old' }, ctx);

    expect((res.data as { refreshToken?: string }).refreshToken).toBe('r-joined');
  });

  it('leaves a failed answer alone even if a cookie was set', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { ok: false, msg: 'auth.otp.wrong' },
        { cookies: ['refresh_token=r-should-not-be-used; Path=/'] },
      ),
    );

    const res = await client().verifyLoginOtp(
      { phoneNumber: '09121112233', otpCode: '000000' },
      ctx,
    );

    expect(res.ok).toBe(false);
    expect(res.data).toBeUndefined();
  });

  it('does not invent a data object to hang the token on', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { ok: true, msg: 'ok' },
        { cookies: ['refresh_token=r-1; Path=/'] },
      ),
    );

    const res = await client().logout({ refreshToken: 'r-0' }, ctx);

    expect(res.ok).toBe(true);
    expect(res.data).toBeUndefined();
  });

  it('leaves the envelope untouched when no cookie came back', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ ok: true, msg: 'ok', data: { accessToken: 'a-1' } }),
    );

    const res = await client().refresh({ refreshToken: 'r-1' }, ctx);

    expect((res.data as { refreshToken?: string }).refreshToken).toBeUndefined();
  });

  // --- failures -----------------------------------------------------------

  it('turns a network failure into the one generic failure envelope', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await client().refresh({ refreshToken: 'r-1' }, ctx);

    expect(res).toEqual({ ok: false, msg: TRY_AGAIN });
  });

  it('turns a non-JSON body into the same envelope', async () => {
    // A 502 from Traefik is HTML; a caller that saw the parse error would
    // crash the update handler instead of answering the chat.
    fetchMock.mockResolvedValue({
      status: 502,
      headers: { getSetCookie: () => [] },
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    } as unknown as Response);

    const res = await client().refresh({ refreshToken: 'r-1' }, ctx);

    expect(res).toEqual({ ok: false, msg: TRY_AGAIN });
  });

  it('replaces a failure envelope that carries no message', async () => {
    // A gateway can answer JSON that is not this platform's envelope. `msg` is
    // rendered as `raw`, so passing an empty one through puts a blank line in
    // the chat where the reason belongs.
    fetchMock.mockResolvedValue(jsonResponse({ ok: false }, { status: 502 }));

    const res = await client().refresh({ refreshToken: 'r-1' }, ctx);

    expect(res).toEqual({ ok: false, msg: TRY_AGAIN });
  });

  it('reads ok, not the status code', async () => {
    // A business rejection arrives with the route's own 2xx and ok:false; a
    // client that branched on the status would read it as a success.
    fetchMock.mockResolvedValue(
      jsonResponse({ ok: false, msg: 'auth.register.duplicate' }, { status: 201 }),
    );

    const res = await client().register(
      {
        fullName: 'Ada',
        username: 'ada',
        phoneNumber: '09121112233',
        password: 'Str0ng!pass',
      },
      ctx,
    );

    expect(res).toEqual({ ok: false, msg: 'auth.register.duplicate' });
  });

  it('passes a 4xx envelope through rather than replacing it', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { ok: false, msg: 'auth.rate.limited', ref: 'req-9' },
        { status: 429 },
      ),
    );

    const res = await client().requestLoginOtp({ phoneNumber: '09121112233' }, ctx);

    expect(res).toMatchObject({ ok: false, msg: 'auth.rate.limited', ref: 'req-9' });
  });

  it('aborts a call that outlives the timeout, and answers with the generic failure', async () => {
    // The abort surfaces as a rejected fetch, which must land on the same
    // envelope rather than leaving an update handler awaiting forever.
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'AbortError')),
          );
        }),
    );

    const res = await client().refresh({ refreshToken: 'r-1' }, ctx);

    expect(res).toEqual({ ok: false, msg: TRY_AGAIN });
  });

  it('passes an abort signal on every call', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, msg: 'ok' }));

    await client().refresh({ refreshToken: 'r-1' }, ctx);

    expect(lastRequest().init.signal).toBeDefined();
  });
});
