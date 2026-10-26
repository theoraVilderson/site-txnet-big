import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type * as OwnerSetup from './owner-setup';
import type { authApi as AuthApi } from '../auth-api';

/**
 * F-0102: the password step of a fresh install's owner answers a setup token
 * and no session. The token reaches the setup screen in memory only — never
 * storage — and the screen's two calls are sent bare, like every login call.
 */
let fetchMock: ReturnType<typeof vi.fn>;
let setup: typeof OwnerSetup;
let authApi: typeof AuthApi;

const envelope = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const lastCall = () => {
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return { url, body: init.body ? JSON.parse(init.body) : undefined, headers: new Headers(init.headers) };
};

beforeEach(async () => {
  vi.resetModules();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  setup = await import('./owner-setup');
  ({ authApi } = await import('../auth-api'));
});

afterEach(() => vi.unstubAllGlobals());

describe('the setup token hand-off', () => {
  it('holds the token for the setup screen until the setup ends', () => {
    expect(setup.heldSetupToken()).toBeNull();
    setup.holdSetupToken('setup-token');
    expect(setup.heldSetupToken()).toBe('setup-token');
    expect(setup.heldSetupToken()).toBe('setup-token');
    setup.releaseSetupToken();
    expect(setup.heldSetupToken()).toBeNull();
  });

  it('keeps it out of browser storage, so a reload starts again from sign-in', () => {
    setup.holdSetupToken('setup-token');
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain('setup-token');
  });
});

describe('the setup calls', () => {
  it('sends the code to the number the owner will keep', async () => {
    fetchMock.mockResolvedValue(envelope({ ok: true, data: { phoneNumber: '+989121234567', requiresPhoneVerification: true, deliveryId: 'd', channel: 'otp:c', channelToken: 't' } }, 202));
    await authApi.sendOwnerSetupCode('setup-token', '+989121234567', 'sms');
    const call = lastCall();
    expect(call.url).toBe('/api/auth/owner-setup/code');
    expect(call.body).toEqual({ setupToken: 'setup-token', phoneNumber: '+989121234567', channel: 'sms' });
    expect(call.headers.get('authorization')).toBeNull();
  });

  it('completes the setup and adopts the session it opens', async () => {
    fetchMock.mockResolvedValue(envelope({ ok: true, data: { accessToken: 'at-1', expiresIn: 900 } }));
    const input = { setupToken: 'setup-token', username: 'theora', newPassword: 'Str0ng!Secret', phoneNumber: '+989121234567', otpCode: '123456' };
    await expect(authApi.completeOwnerSetup(input)).resolves.toMatchObject({ accessToken: 'at-1' });
    expect(lastCall().url).toBe('/api/auth/owner-setup');
    expect(lastCall().body).toEqual(input);

    fetchMock.mockResolvedValue(envelope({ ok: true, data: { channels: [] } }));
    await authApi.otpChannels();
    expect(lastCall().headers.get('authorization')).toBe('Bearer at-1');
  });
});
