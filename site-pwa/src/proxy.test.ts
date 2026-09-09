// @vitest-environment node
//
// `proxy.ts` runs on the server, so does its spec: NextRequest/NextResponse
// need real Request/Response/Headers, not jsdom's.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy, REFRESH_COOKIE } from './proxy';
import { PANEL_HOME } from '@/lib/routes';

const ORIGIN = 'http://auth-service:3000';

/** A cookie header for a visitor who holds a session. */
const SIGNED_IN = `${REFRESH_COOKIE}=abc`;

function requestFor(path: string, cookie?: string) {
  return new NextRequest(`https://panel.example.com${path}`, {
    headers: cookie ? { cookie } : undefined,
  });
}

/** An auth-service answer: status + envelope + any Set-Cookie headers. */
function upstream(
  status: number,
  body: unknown,
  cookies: string[] = [],
): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers,
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv('AUTH_SERVICE_ORIGIN', ORIGIN);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('which requests are checked at all', () => {
  it.each([
    ['the panel home', '/'],
    ['a panel page', '/wallet'],
    // resetting a password while signed in elsewhere is legitimate
    ['forgot-password', '/auth/forgot-password'],
    ['a path that merely starts with a guarded prefix', '/auth/loginhelp'],
    ['a path that merely starts with the old signup prefix', '/auth/signuphelp'],
  ])('passes %s straight through, cookie or not', async (_label, path) => {
    expect(await proxy(requestFor(path, SIGNED_IN))).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['/auth/login'],
    ['/auth/register'],
    ['/auth/login/'],
    ['/auth/register/step-two'],
  ])('guards %s', async (path) => {
    fetchMock.mockResolvedValue(upstream(200, { ok: true, data: { active: true } }));
    const response = await proxy(requestFor(path, SIGNED_IN));
    expect(response?.headers.get('location')).toBe(
      `https://panel.example.com${PANEL_HOME}`,
    );
  });

  it('costs nothing for a visitor with no refresh_token cookie', async () => {
    expect(await proxy(requestFor('/auth/login'))).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ignores other cookies', async () => {
    expect(
      await proxy(requestFor('/auth/login', 'NEXT_LOCALE=fa; NEXT_THEME=dark')),
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the old /auth/signup path', () => {
  // The screen was renamed to `register` — the name auth-api, the bot and
  // coinsite have always used. Links to the old path exist outside this repo
  // (bot deep links, bookmarks, anything already sent), so it must move rather
  // than 404. 308 and not 307: the rename is permanent, and 308 is the one
  // redirect a browser is required to cache *and* to keep the method on.
  it('redirects to /auth/register, permanently', async () => {
    const response = await proxy(requestFor('/auth/signup'));

    expect(response?.status).toBe(308);
    expect(response?.headers.get('location')).toBe(
      'https://panel.example.com/auth/register',
    );
  });

  it('keeps the rest of the path and the query string', async () => {
    const response = await proxy(
      requestFor('/auth/signup/step-two?ref=bot&lang=fa'),
    );

    expect(response?.headers.get('location')).toBe(
      'https://panel.example.com/auth/register/step-two?ref=bot&lang=fa',
    );
  });

  it('redirects before the session check — a rename is not an auth question', async () => {
    // A signed-in visitor on the old path must still land on the new one. The
    // guard then runs on `/auth/register` and sends them home from there, so
    // asking auth-service here would be a wasted round trip on every hit.
    const response = await proxy(requestFor('/auth/signup', SIGNED_IN));

    expect(response?.status).toBe(308);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the session check', () => {
  it('never asks a route that mutates the session', async () => {
    // This is the whole point of the route existing. `/auth/refresh` *rotates*:
    // it revokes the caller's session and mints a replacement. This handler runs
    // on RSC prefetches, redirects and concurrent requests whose responses the
    // browser may never apply, so rotating here handed the browser a revoked
    // cookie it still displayed as present — and the panel then bounced the user
    // back to the login screen on the next real refresh.
    fetchMock.mockResolvedValue(upstream(200, { ok: true, data: { active: true } }));

    await proxy(requestFor('/auth/login', SIGNED_IN));

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).not.toContain('/auth/refresh');
    expect(init.method).toBe('GET');
  });

  it('goes to the internal origin and carries the cookie back', async () => {
    fetchMock.mockResolvedValue(upstream(200, { ok: true, data: { active: true } }));

    await proxy(requestFor('/auth/login', SIGNED_IN));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${ORIGIN}/api/auth/session`);
    expect(init.method).toBe('GET');
    expect(init.cache).toBe('no-store');
    expect(init.headers.cookie).toBe(SIGNED_IN);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('names the tenant it belongs to, by the public API host', async () => {
    // F-066-r. The internal hop reaches auth-service as `auth-service:3000`,
    // which matches no `tenant_domain` row — and since F-066-d removed the
    // fallback tenant, an unresolved host is a 404, so the signed-in visitor
    // was never redirected. The resolver's primary input is the host
    // (ADR-0020), so the panel states the public one it actually belongs to.
    vi.stubEnv('NEXT_PUBLIC_API_ORIGIN', 'https://api.example.com');
    fetchMock.mockResolvedValue(upstream(200, { ok: true, data: { active: true } }));

    await proxy(requestFor('/auth/login', SIGNED_IN));

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['x-forwarded-host']).toBe('api.example.com');
  });

  it('names no host when it is already calling the public origin', async () => {
    // There the real `Host` is already the right one; overriding it would be
    // one more place that can disagree with the URL.
    vi.stubEnv('AUTH_SERVICE_ORIGIN', undefined);
    vi.stubEnv('NEXT_PUBLIC_API_ORIGIN', 'https://api.example.com');
    fetchMock.mockResolvedValue(upstream(200, { ok: true, data: { active: true } }));

    await proxy(requestFor('/auth/login', SIGNED_IN));

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['x-forwarded-host']).toBeUndefined();
  });

  it('names no host when the public origin is unset, rather than an empty one', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_ORIGIN', undefined);
    fetchMock.mockResolvedValue(upstream(200, { ok: true, data: { active: true } }));

    await proxy(requestFor('/auth/login', SIGNED_IN));

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['x-forwarded-host']).toBeUndefined();
  });

  it('falls back to the public origin when the internal one is unset', async () => {
    vi.stubEnv('AUTH_SERVICE_ORIGIN', undefined);
    vi.stubEnv('NEXT_PUBLIC_API_ORIGIN', 'https://api.example.com');
    fetchMock.mockResolvedValue(upstream(200, { ok: true, data: { active: true } }));

    await proxy(requestFor('/auth/login', SIGNED_IN));

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.example.com/api/auth/session',
    );
  });

  it('fails open when neither origin is set — the URL is relative and fetch cannot send it', async () => {
    vi.stubEnv('AUTH_SERVICE_ORIGIN', undefined);
    vi.stubEnv('NEXT_PUBLIC_API_ORIGIN', undefined);
    fetchMock.mockRejectedValue(new TypeError('Failed to parse URL'));

    expect(
      await proxy(requestFor('/auth/login', SIGNED_IN)),
    ).toBeNull();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/auth/session');
  });
});

describe('what the answer means', () => {
  it('redirects a still-signed-in visitor to the panel home', async () => {
    fetchMock.mockResolvedValue(
      upstream(200, { ok: true, data: { active: true } }),
    );

    const response = await proxy(requestFor('/auth/login', SIGNED_IN));

    expect(response?.status).toBe(307);
    expect(response?.headers.get('location')).toBe(
      `https://panel.example.com${PANEL_HOME}`,
    );
  });

  it('shows the form when a 200 carries `ok: false` — the envelope, not the status, settles it', async () => {
    fetchMock.mockResolvedValue(
      upstream(200, { ok: false, msg: 'auth.sessionInactive' }),
    );

    const response = await proxy(requestFor('/auth/login', SIGNED_IN));

    expect(response?.headers.get('location')).toBeNull();
    expect(response?.status).toBe(200);
  });

  it.each([
    ['a 401', 401, { ok: false, msg: 'unauthorized' }],
    ['a 500', 500, { ok: false, msg: 'boom' }],
    ['a 200 with no `ok` at all', 200, { data: {} }],
    ['a 200 whose `ok` is truthy but not true', 200, { ok: 'yes' }],
  ])('shows the form for %s', async (_label, status, body) => {
    fetchMock.mockResolvedValue(upstream(status, body));

    const response = await proxy(requestFor('/auth/login', SIGNED_IN));

    expect(response?.headers.get('location')).toBeNull();
  });

  it('shows the form when the session is reported inactive, `ok` notwithstanding', async () => {
    // The envelope is a success — the *question* was answered. `active` is the
    // answer, and a check that read only `ok` would walk a signed-out visitor
    // into the panel.
    fetchMock.mockResolvedValue(upstream(200, { ok: true, data: { active: false } }));

    const response = await proxy(requestFor('/auth/login', SIGNED_IN));

    expect(response?.headers.get('location')).toBeNull();
  });

  it('shows the form when `active` is missing or merely truthy', async () => {
    for (const data of [{}, { active: 'yes' }, { active: 1 }]) {
      fetchMock.mockResolvedValue(upstream(200, { ok: true, data }));
      const response = await proxy(
        requestFor('/auth/login', SIGNED_IN),
      );
      expect(response?.headers.get('location')).toBeNull();
    }
  });

  it('shows the form when the body is not JSON', async () => {
    fetchMock.mockResolvedValue(upstream(200, '<html>gateway error</html>'));

    const response = await proxy(requestFor('/auth/login', SIGNED_IN));

    expect(response?.headers.get('location')).toBeNull();
  });

  it('fails open to the form when auth-service is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    expect(
      await proxy(requestFor('/auth/login', SIGNED_IN)),
    ).toBeNull();
  });

  it('fails open to the form when the request times out', async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new Error('The operation was aborted'), {
        name: 'TimeoutError',
      }),
    );

    expect(
      await proxy(requestFor('/auth/login', SIGNED_IN)),
    ).toBeNull();
  });
});

describe('set-cookie forwarding', () => {
  it('forwards whatever auth-service sets on success', async () => {
    fetchMock.mockResolvedValue(
      upstream(200, { ok: true, data: { active: true } }, [
        `${REFRESH_COOKIE}=unchanged; Path=/; HttpOnly`,
      ]),
    );

    const response = await proxy(requestFor('/auth/login', SIGNED_IN));

    expect(response?.headers.getSetCookie()).toEqual([
      `${REFRESH_COOKIE}=unchanged; Path=/; HttpOnly`,
    ]);
  });

  it('forwards the clear on failure, so a dead token costs one request only once', async () => {
    fetchMock.mockResolvedValue(
      upstream(401, { ok: false, msg: 'expired' }, [
        `${REFRESH_COOKIE}=; Path=/; Max-Age=0`,
      ]),
    );

    const response = await proxy(requestFor('/auth/login', SIGNED_IN));

    expect(response?.headers.get('location')).toBeNull();
    expect(response?.headers.getSetCookie()).toEqual([
      `${REFRESH_COOKIE}=; Path=/; Max-Age=0`,
    ]);
  });

  it('forwards every cookie auth-service sets', async () => {
    fetchMock.mockResolvedValue(
      upstream(200, { ok: true, data: { active: true } }, [
        `${REFRESH_COOKIE}=rotated; Path=/`,
        'sid=s1; Path=/',
      ]),
    );

    const response = await proxy(requestFor('/auth/login', SIGNED_IN));

    expect(response?.headers.getSetCookie()).toHaveLength(2);
  });
});
