import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { authApi as AuthApi } from './auth-api';
import type { ApiError } from './api-error';

// Same-origin (ADR-0060): every call is a path on the page's own domain.
const ORIGIN = '';

let fetchMock: ReturnType<typeof vi.fn>;
let authApi: typeof AuthApi;

/** A backend answer in the standard envelope. */
function envelope(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function lastCall() {
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return { url, init, headers: new Headers(init.headers) };
}

beforeEach(async () => {
  // `API_URL` and the in-memory access token are module-level, so every test
  // gets a fresh module rather than the previous test's leftovers.
  vi.resetModules();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  ({ authApi } = await import('./auth-api'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('the envelope', () => {
  it('unwraps `data` from a successful answer', async () => {
    fetchMock.mockResolvedValue(
      envelope({ ok: true, data: { resetToken: 'rt_1' } }),
    );

    await expect(authApi.verifyForgot('09120000000', '123456')).resolves.toEqual(
      { resetToken: 'rt_1' },
    );
  });

  it('throws the server message when a 200 carries `ok: false`', async () => {
    fetchMock.mockResolvedValue(
      envelope({ ok: false, msg: 'auth.errors.otpInvalid' }),
    );

    await expect(
      authApi.verifyForgot('09120000000', '000000'),
    ).rejects.toThrow('auth.errors.otpInvalid');
  });

  it('throws the server message on a non-2xx status', async () => {
    fetchMock.mockResolvedValue(
      envelope({ ok: false, msg: 'auth.errors.rateLimited' }, 429),
    );

    await expect(authApi.otpChannels()).rejects.toThrow(
      'auth.errors.rateLimited',
    );
  });

  // auth-api translates before it answers, so `msg` is the sentence to show.
  // The three answers that carry no translated text are marked `unreachable`
  // instead, and the caller shows a line of its own (`useApiErrorMessage`) —
  // never the detail below, which is written for a log.
  it('marks a failure whose body has no `msg` unreachable', async () => {
    fetchMock.mockResolvedValue(envelope({ ok: false }, 500));

    await expect(authApi.otpChannels()).rejects.toMatchObject({
      name: 'ApiError',
      unreachable: true,
    });
  });

  it('marks a failure whose body is not JSON at all unreachable', async () => {
    fetchMock.mockResolvedValue(envelope('<html>502</html>', 502));

    await expect(authApi.otpChannels()).rejects.toMatchObject({
      name: 'ApiError',
      unreachable: true,
    });
  });

  it('keeps the server message and its field errors, already translated', async () => {
    fetchMock.mockResolvedValue(
      envelope(
        {
          ok: false,
          msg: 'اطلاعات وارد شده معتبر نیست',
          ref: 'a1b2c3',
          fieldErrors: [{ path: 'phoneNumber', message: 'شماره معتبر نیست' }],
        },
        400,
      ),
    );

    await expect(authApi.otpChannels()).rejects.toMatchObject({
      message: 'اطلاعات وارد شده معتبر نیست',
      unreachable: false,
      ref: 'a1b2c3',
      fieldErrors: [{ path: 'phoneNumber', message: 'شماره معتبر نیست' }],
    });
  });

  it('treats an unparseable body on a 200 as an empty envelope', async () => {
    // `ok` is absent rather than false, so this is a success with no data.
    fetchMock.mockResolvedValue(envelope(''));

    await expect(authApi.otpChannels()).resolves.toBeUndefined();
  });

  it('turns a network failure into an unreachable ApiError, keeping the cause', async () => {
    const cause = new TypeError('Failed to fetch');
    fetchMock.mockRejectedValue(cause);

    // One failure shape for every caller: a screen that had to tell a
    // TypeError from an envelope would end up showing one of them raw.
    // `resetModules` in beforeEach means the class the client threw is the
    // one from the same fresh module graph, not a statically imported twin.
    const { ApiError } = await import('./api-error');
    const thrown = await authApi.otpChannels().catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).unreachable).toBe(true);
    expect((thrown as ApiError).cause).toBe(cause);
  });
});

describe('the request', () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue(envelope({ ok: true, data: {} }));
  });

  it('calls api.<domain> directly, with cookies', async () => {
    await authApi.otpChannels();

    const { url, init } = lastCall();
    expect(url).toBe(`${ORIGIN}/api/auth/otp/channels`);
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('include');
  });

  it('sends the captcha pass as `x-captcha-token` (auth-api v3)', async () => {
    await authApi.forgot('09120000000', 'cap_1');

    expect(lastCall().headers.get('x-captcha-token')).toBe('cap_1');
  });

  it('omits the captcha header on endpoints that take no pass', async () => {
    await authApi.verifyLoginOtp('09120000000', '123456');

    expect(lastCall().headers.get('x-captcha-token')).toBeNull();
  });

  it('sends the language the panel is showing, not the browser\'s', async () => {
    // auth-api translates an error from Accept-Language, and a browser sends
    // the OS language — so without this a Persian panel on an en-US machine
    // gets English errors back.
    const { setApiLanguage } = await import('./api-language');
    setApiLanguage('fa');

    await authApi.otpChannels();

    expect(lastCall().headers.get('accept-language')).toBe('fa');
  });

  it('sends no authorization header before anything has signed in', async () => {
    await authApi.otpChannels();

    expect(lastCall().headers.get('authorization')).toBeNull();
  });

  it('omits `channel` entirely when the caller does not pick one', async () => {
    await authApi.requestLoginOtp('09120000000', 'cap_1');

    expect(JSON.parse(lastCall().init.body)).toEqual({
      phoneNumber: '09120000000',
    });
  });

  it('sends `channel` when the caller picks one', async () => {
    await authApi.requestLoginOtp('09120000000', 'cap_1', 'telegram');

    expect(JSON.parse(lastCall().init.body)).toEqual({
      phoneNumber: '09120000000',
      channel: 'telegram',
    });
  });
});

describe('the access token', () => {
  it('is remembered after an OTP login and sent on the next call', async () => {
    fetchMock.mockResolvedValueOnce(
      envelope({ ok: true, data: { accessToken: 'at_1', expiresIn: 900 } }),
    );
    await authApi.verifyLoginOtp('09120000000', '123456');
    expect(authApi.getAccessToken()).toBe('at_1');

    fetchMock.mockResolvedValueOnce(envelope({ ok: true, data: {} }));
    await authApi.otpChannels();

    expect(lastCall().headers.get('authorization')).toBe('Bearer at_1');
  });

  it('is remembered after a password login that returns one', async () => {
    fetchMock.mockResolvedValue(
      envelope({ ok: true, data: { accessToken: 'at_2', expiresIn: 900 } }),
    );

    await authApi.loginPassword('user', 'pw', 'cap_1');

    expect(authApi.getAccessToken()).toBe('at_2');
  });

  it('is not set when a password login answers `requiresOtp`', async () => {
    fetchMock.mockResolvedValue(
      envelope({ ok: true, data: { requiresOtp: true } }),
    );

    await expect(authApi.loginPassword('user', 'pw', 'cap_1')).resolves.toEqual({
      requiresOtp: true,
    });
    expect(authApi.getAccessToken()).toBeNull();
  });

  it('is replaced by the session a password reset hands back', async () => {
    fetchMock.mockResolvedValue(
      envelope({
        ok: true,
        data: { success: true, accessToken: 'at_3', expiresIn: 900 },
      }),
    );

    await authApi.reset('rt_1', 'new-password');

    expect(authApi.getAccessToken()).toBe('at_3');
  });

  it('is rotated by refresh', async () => {
    fetchMock.mockResolvedValue(
      envelope({ ok: true, data: { accessToken: 'at_4', expiresIn: 900 } }),
    );

    await authApi.refresh();

    expect(authApi.getAccessToken()).toBe('at_4');
  });

  it('is cleared by logout', async () => {
    fetchMock.mockResolvedValueOnce(
      envelope({ ok: true, data: { accessToken: 'at_5', expiresIn: 900 } }),
    );
    await authApi.refresh();

    fetchMock.mockResolvedValueOnce(envelope({ ok: true, data: { success: true } }));
    await authApi.logout();

    expect(authApi.getAccessToken()).toBeNull();
  });

  it('survives a failed call — a rejected request must not sign the user out', async () => {
    fetchMock.mockResolvedValueOnce(
      envelope({ ok: true, data: { accessToken: 'at_6', expiresIn: 900 } }),
    );
    await authApi.refresh();

    fetchMock.mockResolvedValueOnce(envelope({ ok: false, msg: 'nope' }));
    await expect(authApi.otpChannels()).rejects.toThrow('nope');

    expect(authApi.getAccessToken()).toBe('at_6');
  });
});

describe('the bot-link branch of an OTP request', () => {
  it('returns the deep link when the messenger is not connected yet', async () => {
    const linkRequired = {
      accepted: true,
      linkRequired: true,
      platform: 'telegram',
      linkToken: 'lt_1',
      deepLink: 'https://t.me/bot?start=lt_1',
      expiresIn: 300,
    };
    fetchMock.mockResolvedValue(envelope({ ok: true, data: linkRequired }));

    await expect(
      authApi.forgot('09120000000', 'cap_1', 'telegram'),
    ).resolves.toEqual(linkRequired);
  });

  it('reports link status', async () => {
    fetchMock.mockResolvedValue(
      envelope({ ok: true, data: { state: 'linked', otpSent: true } }),
    );

    await expect(authApi.botLinkStatus('lt_1')).resolves.toEqual({
      state: 'linked',
      otpSent: true,
    });
    expect(JSON.parse(lastCall().init.body)).toEqual({ linkToken: 'lt_1' });
  });
});

/**
 * F-0206 / F-0207 / F-0209. The two things worth pinning on the client side
 * are the ones a page cannot see for itself: that the switch adopts the new
 * account's token immediately (the old session is already revoked server-side
 * by the time this resolves), and that `ensureSession` rotates the refresh
 * cookie exactly once no matter how many callers ask.
 */
describe('the switch group', () => {
  it('reads the group over GET', async () => {
    fetchMock.mockResolvedValue(
      envelope({
        ok: true,
        data: {
          groupId: 'g1',
          current: { userId: 'u1', fullName: 'A', phoneMasked: '0912***0001' },
          members: [],
        },
      }),
    );

    const group = await authApi.listAccounts();

    expect(group.current.userId).toBe('u1');
    expect(lastCall().url).toBe(`${ORIGIN}/api/auth/accounts`);
    expect(lastCall().init.method).toBe('GET');
  });

  it('switches, and sends the new account token on the next call', async () => {
    fetchMock.mockResolvedValueOnce(
      envelope({
        ok: true,
        data: {
          userId: 'u2',
          fullName: 'B',
          accessToken: 'access-u2',
          expiresIn: 900,
        },
      }),
    );
    await authApi.switchAccount('u2');

    fetchMock.mockResolvedValueOnce(envelope({ ok: true, data: {} }));
    await authApi.listAccounts();

    expect(lastCall().headers.get('authorization')).toBe('Bearer access-u2');
  });

  it('removes a member by id, over POST', async () => {
    fetchMock.mockResolvedValue(
      envelope({ ok: true, data: { userId: 'u2', removed: true } }),
    );

    const result = await authApi.removeAccount('u2');

    expect(result).toEqual({ userId: 'u2', removed: true });
    expect(lastCall().url).toBe(`${ORIGIN}/api/auth/accounts/remove`);
    expect(lastCall().init.method).toBe('POST');
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ userId: 'u2' });
  });

  it('sends the cookie on a removal — the scope rides on it (ADR-0015)', async () => {
    fetchMock.mockResolvedValue(
      envelope({ ok: true, data: { userId: 'u2', removed: true } }),
    );

    await authApi.removeAccount('u2');

    // `device_id` is httpOnly, so the browser attaches it and this code never
    // sees it. Dropping `credentials: "include"` would send the call with no
    // scope at all, and the server would refuse every removal.
    expect(lastCall().init.credentials).toBe('include');
  });

  it('refreshes once per page load however many callers ask', async () => {
    fetchMock.mockResolvedValue(
      envelope({ ok: true, data: { accessToken: 'a1', expiresIn: 900 } }),
    );

    // A second rotation would spend a refresh token the first one replaced,
    // and the loser would be signed out.
    await Promise.all([authApi.ensureSession(), authApi.ensureSession()]);
    await authApi.ensureSession();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * A call refused because the caller's permissions changed after its token was
 * minted (ADR-0043). The gate answers 401 with `error.reason:
 * "permissionsChanged"`, and the one thing that must hold is that the user never
 * sees that refusal: the panel refreshes once, retries once, and the menu is
 * told. Each case below is a way that goes wrong without a single visible error
 * anywhere else — a retry storm, a double refresh that rotates the token out
 * from under the other call, or an ordinary sign-out mistaken for this.
 */
describe('a call refused because permissions changed', () => {
  const stale = () =>
    envelope(
      { ok: false, msg: 'Your access has changed.', error: { reason: 'permissionsChanged' } },
      401,
    );
  const refreshed = (token: string) =>
    envelope({ ok: true, data: { accessToken: token, expiresIn: 900 } });
  const accounts = () =>
    envelope({ ok: true, data: { groupId: null, current: { userId: 'u-1', fullName: 'A', phoneMasked: null }, members: [] } });
  const auth = (call: unknown[]) => new Headers((call[1] as RequestInit).headers).get('authorization');

  it('refreshes once and retries with the new token', async () => {
    fetchMock
      .mockResolvedValueOnce(stale())
      .mockResolvedValueOnce(refreshed('tok-new'))
      .mockResolvedValueOnce(accounts());

    await expect(authApi.listAccounts()).resolves.toMatchObject({ groupId: null });

    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toEqual([
      `${ORIGIN}/api/auth/accounts`,
      `${ORIGIN}/api/auth/refresh`,
      `${ORIGIN}/api/auth/accounts`,
    ]);
    expect(auth(fetchMock.mock.calls[2])).toBe('Bearer tok-new');
  });

  it('refreshes once for several calls refused together', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/auth/refresh')) return refreshed('tok-new');
      const sawRefresh = fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/auth/refresh'));
      return sawRefresh ? accounts() : stale();
    });

    await Promise.all([authApi.listAccounts(), authApi.listAccounts(), authApi.listAccounts()]);

    const refreshes = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/auth/refresh'));
    expect(refreshes).toHaveLength(1);
  });

  it('throws a second refusal rather than retrying again', async () => {
    fetchMock
      .mockResolvedValueOnce(stale())
      .mockResolvedValueOnce(refreshed('tok-new'))
      .mockResolvedValueOnce(stale());

    const thrown = (await authApi.listAccounts().catch((e: unknown) => e)) as ApiError;

    expect(thrown.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('refreshes and retries a call refused only because the access token expired', async () => {
    fetchMock
      .mockResolvedValueOnce(envelope({ ok: false, msg: 'Token has expired', error: { reason: 'tokenExpired' } }, 401))
      .mockResolvedValueOnce(refreshed('tok-new'))
      .mockResolvedValueOnce(accounts());

    await expect(authApi.listAccounts()).resolves.toMatchObject({ groupId: null });
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([
      `${ORIGIN}/api/auth/accounts`,
      `${ORIGIN}/api/auth/refresh`,
      `${ORIGIN}/api/auth/accounts`,
    ]);
    expect(auth(fetchMock.mock.calls[2])).toBe('Bearer tok-new');
  });

  it('does not refresh on an ordinary 401, which means the session is gone', async () => {
    fetchMock.mockResolvedValueOnce(
      envelope({ ok: false, msg: 'Your session has expired.' }, 401),
    );

    await expect(authApi.listAccounts()).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws the original refusal when the refresh itself fails', async () => {
    fetchMock
      .mockResolvedValueOnce(stale())
      .mockResolvedValueOnce(envelope({ ok: false, msg: 'Your session has expired.' }, 401));

    const thrown = (await authApi.listAccounts().catch((e: unknown) => e)) as ApiError;

    expect(thrown.message).toBe('Your access has changed.');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('tells listeners after the refresh, so the panel re-reads `me`', async () => {
    const listener = vi.fn();
    const unsubscribe = authApi.onPermissionsRefreshed(listener);
    fetchMock
      .mockResolvedValueOnce(stale())
      .mockResolvedValueOnce(refreshed('tok-new'))
      .mockResolvedValueOnce(accounts());

    await authApi.listAccounts();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    fetchMock
      .mockResolvedValueOnce(stale())
      .mockResolvedValueOnce(refreshed('tok-newer'))
      .mockResolvedValueOnce(accounts());
    await authApi.listAccounts();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

/**
 * Every call whose access token was refused for a reason a refresh can mend is
 * refreshed and sent again, once — and there is one refresh for the whole
 * browser. Refresh *rotates* the session: the one it replaces is revoked on the
 * spot, so two refreshes racing with the same cookie sign the loser out, and a
 * tab that refreshes retires the token every other tab is holding. The shared
 * lock and the broadcast are what let several tabs and the socket live on one
 * session.
 */
describe('one refresh for every call, socket and tab', () => {
  const jwt = (sub: string, n: string) =>
    `h.${Buffer.from(JSON.stringify({ sub, n })).toString('base64url')}.s`;
  const refreshed = (token: string) => envelope({ ok: true, data: { accessToken: token, expiresIn: 900 } });
  const accounts = () =>
    envelope({ ok: true, data: { groupId: null, current: { userId: 'u-1', fullName: 'A', phoneMasked: null }, members: [] } });
  const revoked = () => envelope({ ok: false, msg: 'Session revoked', error: { reason: 'sessionRevoked' } }, 401);
  const auth = (call: unknown[]) => new Headers((call[1] as RequestInit).headers).get('authorization');
  const refreshes = () => fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/auth/refresh'));
  const tick = () => new Promise((r) => setTimeout(r, 20));
  const channels: BroadcastChannel[] = [];
  const otherTab = () => {
    const c = new BroadcastChannel('txnet:auth');
    channels.push(c);
    return c;
  };
  afterEach(() => channels.splice(0).forEach((c) => c.close()));

  it('refreshes and retries a call whose session was revoked by a rotation elsewhere', async () => {
    fetchMock.mockResolvedValueOnce(refreshed(jwt('u-1', 'a')));
    await authApi.ensureSession();
    fetchMock.mockResolvedValueOnce(revoked()).mockResolvedValueOnce(refreshed(jwt('u-1', 'b'))).mockResolvedValueOnce(accounts());

    await expect(authApi.listAccounts()).resolves.toMatchObject({ groupId: null });
    expect(auth(fetchMock.mock.calls[3])).toBe(`Bearer ${jwt('u-1', 'b')}`);
  });

  it('shares one refresh between the socket and a refused call', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/auth/refresh')) return refreshed(jwt('u-1', 'n'));
      return refreshes().length ? accounts() : revoked();
    });

    await Promise.all([authApi.refreshCredential(), authApi.listAccounts()]);
    expect(refreshes()).toHaveLength(1);
  });

  it('tells other tabs the new token, and adopts the one another tab rotated', async () => {
    const tab = otherTab();
    const heard: unknown[] = [];
    tab.onmessage = (e) => heard.push(e.data);
    fetchMock.mockResolvedValueOnce(refreshed(jwt('u-1', 'a')));
    await authApi.ensureSession();
    await tick();
    expect(heard).toEqual([{ accessToken: jwt('u-1', 'a') }]);

    tab.postMessage({ accessToken: jwt('u-1', 'b') });
    await tick();
    fetchMock.mockResolvedValueOnce(accounts());
    await authApi.listAccounts();
    expect(auth(fetchMock.mock.calls[1])).toBe(`Bearer ${jwt('u-1', 'b')}`);
  });

  it('ignores a token for another user', async () => {
    fetchMock.mockResolvedValueOnce(refreshed(jwt('u-1', 'a')));
    await authApi.ensureSession();
    otherTab().postMessage({ accessToken: jwt('u-2', 'x') });
    await tick();
    fetchMock.mockResolvedValueOnce(accounts());
    await authApi.listAccounts();
    expect(auth(fetchMock.mock.calls[1])).toBe(`Bearer ${jwt('u-1', 'a')}`);
  });

  it('retries with a token already adopted, without rotating the session again', async () => {
    fetchMock.mockResolvedValueOnce(refreshed(jwt('u-1', 'a')));
    await authApi.ensureSession();
    const tab = otherTab();
    fetchMock
      .mockImplementationOnce(async () => {
        tab.postMessage({ accessToken: jwt('u-1', 'b') });
        await tick();
        return revoked();
      })
      .mockResolvedValueOnce(accounts());

    await authApi.listAccounts();
    expect(refreshes()).toHaveLength(1); // the page-load one only
    expect(auth(fetchMock.mock.calls[2])).toBe(`Bearer ${jwt('u-1', 'b')}`);
  });

  it('throws the original refusal when the cookie cannot mend it either', async () => {
    fetchMock.mockResolvedValueOnce(refreshed(jwt('u-1', 'a')));
    await authApi.ensureSession();
    fetchMock.mockResolvedValueOnce(revoked()).mockResolvedValueOnce(envelope({ ok: false, msg: 'Invalid refresh token' }, 401));

    await expect(authApi.listAccounts()).rejects.toThrow('Session revoked');
  });

  it('a call made before the page-load session resolves waits for it and carries the token', async () => {
    let answer!: (r: Response) => void;
    fetchMock
      .mockImplementationOnce(() => new Promise<Response>((r) => (answer = r)))
      .mockResolvedValueOnce(accounts());

    const session = authApi.ensureSession();
    const call = authApi.listAccounts();
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the refresh is out
    answer(refreshed(jwt('u-1', 'a')));
    await session;
    await call;
    expect(auth(fetchMock.mock.calls[1])).toBe(`Bearer ${jwt('u-1', 'a')}`);
  });

  it('a call refused for carrying no credential gets one from the cookie and is sent again', async () => {
    fetchMock
      .mockResolvedValueOnce(envelope({ ok: false, msg: 'Authorization required', error: { reason: 'authorizationRequired' } }, 401))
      .mockResolvedValueOnce(refreshed(jwt('u-1', 'a')))
      .mockResolvedValueOnce(accounts());

    await expect(authApi.listAccounts()).resolves.toMatchObject({ groupId: null });
    expect(refreshes()).toHaveLength(1);
    expect(auth(fetchMock.mock.calls[2])).toBe(`Bearer ${jwt('u-1', 'a')}`);
  });

  it('shares the page-load refresh with a call refused for carrying no credential', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/auth/refresh')) {
        await tick();
        return refreshed(jwt('u-1', 'a'));
      }
      const hasToken = new Headers((fetchMock.mock.calls.at(-1)![1] as RequestInit).headers).get('authorization');
      return hasToken ? accounts() : envelope({ ok: false, msg: 'Authorization required', error: { reason: 'authorizationRequired' } }, 401);
    });

    await Promise.all([authApi.ensureSession(), authApi.listAccounts()]);
    expect(refreshes()).toHaveLength(1);
  });

  // React runs a child's effect before its parent's, so a sidebar entry's call
  // goes out tokenless *before* `PanelSessionProvider` starts the page-load
  // refresh, and its 401 lands after that refresh is done. A second rotation
  // then, racing the provider's first reads, is what bounced a signed-in
  // user to the login screen while login said "already signed in".
  it('a tokenless call refused after the page-load refresh finished retries on that token, not a new rotation', async () => {
    let refuse!: () => void;
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.endsWith('/auth/refresh')) return refreshed(jwt('u-1', 'a'));
      if (!new Headers(init.headers).get('authorization')) {
        await new Promise<void>((r) => (refuse = r));
        return envelope({ ok: false, msg: 'Authorization required', error: { reason: 'authorizationRequired' } }, 401);
      }
      return accounts();
    });

    const call = authApi.listAccounts();
    await tick();
    await authApi.ensureSession();
    refuse();
    await call;

    expect(refreshes()).toHaveLength(1);
    expect(auth(fetchMock.mock.calls.at(-1)!)).toBe(`Bearer ${jwt('u-1', 'a')}`);
  });

  // The same order, closed at the source: the provider holds calls from its
  // layout effect, which runs before any child's `useEffect`, so the sidebar's
  // call is never sent tokenless to be refused (`GET /auth/handoff` 401).
  it('a tokenless call made while the panel holds for its session waits, and goes out with the token', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith('/auth/refresh') ? refreshed(jwt('u-1', 'a')) : accounts(),
    );

    authApi.holdUntilSession();
    const call = authApi.listAccounts();
    await tick();
    expect(fetchMock).not.toHaveBeenCalled();

    await authApi.ensureSession();
    authApi.releaseSessionHold();
    await call;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(auth(fetchMock.mock.calls[1])).toBe(`Bearer ${jwt('u-1', 'a')}`);
  });

  it('a call released without a session is sent as it is, and the login screen answers it', async () => {
    fetchMock.mockResolvedValue(accounts());
    authApi.holdUntilSession();
    const call = authApi.listAccounts();
    authApi.releaseSessionHold();
    await call;
    expect(auth(fetchMock.mock.calls[0])).toBeNull();
  });

  it('the Mini App sign-in is not held: it is how the held session is made', async () => {
    fetchMock.mockResolvedValueOnce(
      envelope({ ok: true, data: { state: 'authenticated', accessToken: jwt('u-1', 'a'), expiresIn: 900 } }),
    );
    authApi.holdUntilSession();
    await expect(authApi.webAppSession('telegram', 'init')).resolves.toMatchObject({ state: 'authenticated' });
    authApi.releaseSessionHold();
  });

  it('holds nothing once a token is live', async () => {
    fetchMock.mockResolvedValueOnce(refreshed(jwt('u-1', 'a'))).mockResolvedValueOnce(accounts());
    await authApi.ensureSession();
    authApi.holdUntilSession();
    await authApi.listAccounts();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('the page-load session joins a refresh already in flight instead of racing it with the same cookie', async () => {
    fetchMock.mockImplementation(async () => {
      await tick();
      return refreshed(jwt('u-1', 'a'));
    });

    await Promise.all([authApi.refreshCredential(), authApi.ensureSession()]);
    expect(refreshes()).toHaveLength(1);
  });

  it('the page-load session takes the cross-tab lock, so another tab cannot rotate under it', async () => {
    const request = vi.fn((_name: string, fn: () => Promise<unknown>) => fn());
    vi.stubGlobal('navigator', { ...navigator, locks: { request } });
    fetchMock.mockResolvedValueOnce(refreshed(jwt('u-1', 'a')));

    await authApi.ensureSession();
    expect(request).toHaveBeenCalledWith('txnet:auth-refresh', expect.any(Function));
  });

  it('does not rotate again when a sign-in on this page already left a token', async () => {
    fetchMock.mockResolvedValueOnce(
      envelope({ ok: true, data: { accessToken: jwt('u-1', 'a'), expiresIn: 900 } }),
    );
    await authApi.loginPassword('e2e_user', 'pw', 'cap');

    await authApi.ensureSession();
    expect(refreshes()).toHaveLength(0);
  });
});

