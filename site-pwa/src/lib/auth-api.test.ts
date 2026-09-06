import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { authApi as AuthApi } from './auth-api';

const ORIGIN = 'https://api.example.com';

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
  vi.stubEnv('NEXT_PUBLIC_API_ORIGIN', ORIGIN);
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

  it('falls back to a generic message when the body has no `msg`', async () => {
    fetchMock.mockResolvedValue(envelope({ ok: false }, 500));

    await expect(authApi.otpChannels()).rejects.toThrow('Request failed');
  });

  it('falls back to a generic message when the body is not JSON at all', async () => {
    fetchMock.mockResolvedValue(envelope('<html>502</html>', 502));

    await expect(authApi.otpChannels()).rejects.toThrow('Request failed');
  });

  it('treats an unparseable body on a 200 as an empty envelope', async () => {
    // `ok` is absent rather than false, so this is a success with no data.
    fetchMock.mockResolvedValue(envelope(''));

    await expect(authApi.otpChannels()).resolves.toBeUndefined();
  });

  it('lets a network failure through untouched', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(authApi.otpChannels()).rejects.toThrow('Failed to fetch');
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
