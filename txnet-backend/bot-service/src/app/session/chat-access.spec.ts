import { aBotIntegration } from '@txnet-backend/messenger';
import { AuthApiClient } from '../auth-api/auth-api.client';
import { ChatContext } from '../conversation/nav.types';
import { BotSessionStore } from './bot-session.store';
import { ChatAccess } from './chat-access';

/**
 * Two rules live here and nowhere else, and both are invisible until they are
 * broken by a change somewhere upstream:
 *
 *   - **the rotated refresh token is stored before anything else.** auth-api
 *     rotates on every refresh, so the token the chat still holds has been
 *     spent. Not storing the new one signs the chat out on its next message —
 *     an intermittent logout that reproduces once per conversation.
 *   - **a refused refresh is terminal, not transient.** The session is gone
 *     (revoked, switched from the panel, thirty days old), so the entry is
 *     dropped here rather than at some later screen that cannot explain
 *     itself.
 */

const ctx: ChatContext = {
  integration: aBotIntegration(),
  platform: 'telegram',
  chatId: '5501',
  lang: 'fa',
};

function sessions(initial?: { refreshToken: string }) {
  const store = {
    value: initial ?? null,
    get: jest.fn(async () => store.value),
    save: jest.fn(async (_p: string, _c: string, token: string) => {
      store.value = { refreshToken: token };
    }),
    clear: jest.fn(async () => {
      store.value = null;
    }),
  };
  return store;
}

function access(
  store: ReturnType<typeof sessions>,
  refresh: jest.Mock,
) {
  const api = { refresh } as unknown as AuthApiClient;
  return {
    chatAccess: new ChatAccess(api, store as unknown as BotSessionStore),
    api,
  };
}

describe('ChatAccess', () => {
  it('mints an access token from the stored refresh token', async () => {
    const store = sessions({ refreshToken: 'r-1' });
    const refresh = jest.fn(async () => ({
      ok: true,
      msg: 'ok',
      data: { accessToken: 'a-1', expiresIn: 900, refreshToken: 'r-2' },
    }));
    const { chatAccess } = access(store, refresh);

    expect(await chatAccess.token(ctx)).toBe('a-1');
    expect(refresh).toHaveBeenCalledWith(
      { refreshToken: 'r-1' },
      { chatId: '5501', lang: 'fa', platform: 'telegram', tenantId: 'tenant-1' },
    );
  });

  it('stores the rotated refresh token, so the next message still works', async () => {
    const store = sessions({ refreshToken: 'r-1' });
    let call = 0;
    const refresh = jest.fn(async ({ refreshToken }: { refreshToken: string }) => {
      call += 1;
      // auth-api refuses a spent token — exactly what would happen if the
      // rotation were not stored.
      if (refreshToken !== `r-${call}`) {
        return { ok: false, msg: 'auth.session.expired' };
      }
      return {
        ok: true,
        msg: 'ok',
        data: { accessToken: `a-${call}`, expiresIn: 900, refreshToken: `r-${call + 1}` },
      };
    });
    const { chatAccess } = access(store, refresh);

    expect(await chatAccess.token(ctx)).toBe('a-1');
    expect(store.save).toHaveBeenCalledWith(ctx.integration, '5501', 'r-2');
    // The second message of the same conversation.
    expect(await chatAccess.token(ctx)).toBe('a-2');
  });

  it('reports a chat with no session as signed out without calling auth-api', async () => {
    const store = sessions(null as unknown as { refreshToken: string });
    const refresh = jest.fn();
    const { chatAccess } = access(store, refresh);

    expect(await chatAccess.token(ctx)).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('signs the chat out here when auth-api refuses the refresh', async () => {
    const store = sessions({ refreshToken: 'r-1' });
    const refresh = jest.fn(async () => ({ ok: false, msg: 'auth.session.revoked' }));
    const { chatAccess } = access(store, refresh);

    expect(await chatAccess.token(ctx)).toBeNull();
    expect(store.clear).toHaveBeenCalledWith(ctx.integration, '5501');
    expect(store.save).not.toHaveBeenCalled();
    // And the chat really is signed out, not just told so once.
    expect(await chatAccess.token(ctx)).toBeNull();
  });

  it('treats an ok answer with no access token as a refusal', async () => {
    // A malformed success is not a session; carrying on with `undefined` as a
    // bearer token would fail at the next call with a far worse message.
    const store = sessions({ refreshToken: 'r-1' });
    const refresh = jest.fn(async () => ({ ok: true, msg: 'ok', data: { expiresIn: 900 } }));
    const { chatAccess } = access(store, refresh);

    expect(await chatAccess.token(ctx)).toBeNull();
    expect(store.clear).toHaveBeenCalled();
  });

  it('keeps the old refresh token when auth-api rotates nothing', async () => {
    // Not every auth-api answer carries a new refresh token; clearing or
    // overwriting with undefined would sign the chat out for no reason.
    const store = sessions({ refreshToken: 'r-1' });
    const refresh = jest.fn(async () => ({
      ok: true,
      msg: 'ok',
      data: { accessToken: 'a-1', expiresIn: 900 },
    }));
    const { chatAccess } = access(store, refresh);

    expect(await chatAccess.token(ctx)).toBe('a-1');
    expect(store.save).not.toHaveBeenCalled();
    expect(store.clear).not.toHaveBeenCalled();
    expect(store.value).toEqual({ refreshToken: 'r-1' });
  });

  it('never caches the access token it mints', async () => {
    // An access token lives fifteen minutes; caching one would hold a
    // credential in Redis longer than auth-api intends it to exist. Two calls
    // must be two refreshes.
    const store = sessions({ refreshToken: 'r-1' });
    const refresh = jest.fn(async () => ({
      ok: true,
      msg: 'ok',
      data: { accessToken: 'a-1', expiresIn: 900 },
    }));
    const { chatAccess } = access(store, refresh);

    await chatAccess.token(ctx);
    await chatAccess.token(ctx);

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(store.save).not.toHaveBeenCalled();
  });

  it('carries the calling chat’s platform and language into auth-api', async () => {
    // ADR-0015: without the platform, auth-api cannot tell two chats apart
    // and refuses rather than guessing.
    const store = sessions({ refreshToken: 'r-1' });
    const refresh = jest.fn(async () => ({
      ok: true,
      msg: 'ok',
      data: { accessToken: 'a-1', expiresIn: 900 },
    }));
    const { chatAccess } = access(store, refresh);

    await chatAccess.token({ integration: aBotIntegration(), platform: 'bale', chatId: '77', lang: 'en' });

    expect(refresh).toHaveBeenCalledWith(
      { refreshToken: 'r-1' },
      { chatId: '77', lang: 'en', platform: 'bale', tenantId: 'tenant-1' },
    );
  });
});
