import { aBotIntegration } from '@txnet-backend/messenger';
import { AuthApiClient } from '../auth-api/auth-api.client';
import { ChatContext, NavState } from '../conversation/nav.types';
import { BotSessionStore } from '../session/bot-session.store';
import { AccountSwitcher } from '../session/account-switcher';
import { ChatAccess } from '../session/chat-access';
import { AccountsFlow } from './accounts.flow';

const ctx: ChatContext = { integration: aBotIntegration(), platform: 'telegram', chatId: '5501', senderId: 42, lang: 'fa' };
const ok = <T>(data: T) => ({ ok: true, msg: 'ok', data });

const GROUP = {
  groupId: 'g-1',
  current: { userId: 'u-1', fullName: 'Ali', phoneMasked: '0912***2233' },
  members: [{ userId: 'u-2', fullName: 'Sara', phoneMasked: '0912***9988' }],
};

function harness(over: { session?: unknown; api?: Partial<AuthApiClient> } = {}) {
  const api = {
    // Every authenticated call is preceded by a refresh, and the refresh
    // rotates — `r-next` is what must end up in the store.
    refresh: jest
      .fn()
      .mockResolvedValue(ok({ accessToken: 'access-1', expiresIn: 900, refreshToken: 'r-next' })),
    listAccounts: jest.fn().mockResolvedValue(ok(GROUP)),
    switchAccount: jest.fn().mockResolvedValue(
      ok({ userId: 'u-2', fullName: 'Sara', accessToken: 'a', expiresIn: 900, refreshToken: 'r-sara' }),
    ),
    removeAccount: jest.fn().mockResolvedValue(ok({ userId: 'u-2', removed: true })),
    ...over.api,
  } as unknown as jest.Mocked<AuthApiClient>;
  const sessions = {
    get: jest.fn().mockResolvedValue(
      'session' in over ? over.session : { refreshToken: 'r-1', signedInAt: 0 },
    ),
    save: jest.fn(),
    clear: jest.fn(),
  } as unknown as BotSessionStore;
  return {
    api,
    sessions,
    flow: new AccountsFlow(
      api,
      new ChatAccess(api, sessions),
      sessions,
      new AccountSwitcher(api, sessions),
    ),
  };
}

describe('AccountsFlow', () => {
  it('lists the group with the caller as text and every other member as a choice', async () => {
    const { flow, api } = harness();

    const result = await flow.start(ctx);

    expect(result.view.id).toBe('accounts.list');
    expect(api.listAccounts).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'access-1' }),
    );
    // One choice per member, plus the cancel row. The current account is in
    // the body, not on a button that would do nothing.
    const ids = (result.view.actions ?? []).flat().map((a) => a.id);
    expect(ids).toContain('account:u-2');
    expect(ids).not.toContain('account:u-1');
  });

  it('stores the rotated refresh token before the group is even read', async () => {
    const { flow, sessions } = harness();

    await flow.start(ctx);

    expect(sessions.save).toHaveBeenCalledWith(ctx.integration, '5501', 'r-next');
  });

  it('switches and keeps the only refresh token that is still alive', async () => {
    const { flow, api, sessions } = harness();
    const state: NavState = { flow: 'accounts', step: 'accounts.pick', data: {} };

    const result = await flow.handle(ctx, state, 'account:u-2');

    expect(api.switchAccount).toHaveBeenCalledWith({ userId: 'u-2' }, expect.anything());
    expect(sessions.save).toHaveBeenLastCalledWith(ctx.integration, '5501', 'r-sara');
    expect(result.view.id).toBe('accounts.switched');
    expect(result.nextState).toBeNull();
  });

  it('keeps the user on the list when auth-api refuses the switch', async () => {
    const { flow, sessions } = harness({
      api: {
        switchAccount: jest
          .fn()
          .mockResolvedValue({ ok: false, msg: 'accountSwitch.notAMember' }),
      } as Partial<AuthApiClient>,
    });
    const state: NavState = { flow: 'accounts', step: 'accounts.pick', data: {} };

    const result = await flow.handle(ctx, state, 'account:u-9');

    // The refusal is auth-api's own sentence, and the conversation survives it.
    expect(result.view.body.raw).toBe('accountSwitch.notAMember');
    expect(result.nextState).toBe(state);
    expect(sessions.save).toHaveBeenCalledTimes(1); // the refresh rotation only
  });

  it('signs the chat out when its refresh token is no longer accepted', async () => {
    const { flow, sessions, api } = harness({
      api: { refresh: jest.fn().mockResolvedValue({ ok: false, msg: 'auth.sessionExpired' }) } as Partial<AuthApiClient>,
    });

    const result = await flow.start(ctx);

    expect(sessions.clear).toHaveBeenCalledWith(ctx.integration, '5501');
    expect(api.listAccounts).not.toHaveBeenCalled();
    expect(result.view.id).toBe('accounts.signedOut');
  });

  it('offers no switch at all to a chat with no session', async () => {
    const { flow, api } = harness({ session: null });

    const result = await flow.start(ctx);

    expect(api.refresh).not.toHaveBeenCalled();
    expect(result.view.id).toBe('accounts.signedOut');
  });

  it('tells a lone account how to gain a second one instead of showing an empty list', async () => {
    const { flow } = harness({
      api: {
        listAccounts: jest.fn().mockResolvedValue(ok({ ...GROUP, groupId: null, members: [] })),
      } as Partial<AuthApiClient>,
    });

    const result = await flow.start(ctx);

    expect(result.view.id).toBe('accounts.none');
  });

  /**
   * ADR-0015 made the chat's group a property of the chat, and `x-bot-platform`
   * is the half of the chat's identity that auth-api cannot infer. Without it
   * every account call is refused, so this is asserted on the call itself
   * rather than trusted to a code reading.
   */
  it('names the platform on every account call, not just the chat id', async () => {
    const { flow, api } = harness();

    await flow.start(ctx);

    expect(api.listAccounts).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: '5501', platform: 'telegram' }),
    );
  });

  it('offers a way out of the group once there is something to remove', async () => {
    const { flow } = harness();

    const result = await flow.start(ctx);

    const ids = (result.view.actions ?? []).flat().map((a) => a.id);
    expect(ids).toContain('accounts:remove');
  });

  it('asks before removing, and does not call auth-api on the first tap', async () => {
    const { flow, api } = harness();
    const state: NavState = { flow: 'accounts', step: 'accounts.remove.pick', data: {} };

    const result = await flow.handle(ctx, state, 'drop:u-2');

    expect(result.view.id).toBe('accounts.remove.confirm');
    expect(api.removeAccount).not.toHaveBeenCalled();
    // The id is remembered so the confirm tap cannot be replayed against a
    // different account than the one that was named.
    expect(result.nextState?.data.target).toBe('u-2');
  });

  it('removes on the confirming tap and keeps the chat signed in', async () => {
    const { flow, api, sessions } = harness();
    const state: NavState = {
      flow: 'accounts',
      step: 'accounts.remove.confirm',
      data: { target: 'u-2' },
    };

    const result = await flow.handle(ctx, state, 'drop:u-2');

    expect(api.removeAccount).toHaveBeenCalledWith(
      { userId: 'u-2' },
      expect.objectContaining({ platform: 'telegram' }),
    );
    expect(result.view.id).toBe('accounts.removed');
    // Someone else was removed, so this chat's own session is untouched.
    expect(sessions.clear).not.toHaveBeenCalled();
  });

  it('drops the stored token when the chat removes its OWN account', async () => {
    const { flow, sessions } = harness({
      api: {
        removeAccount: jest.fn().mockResolvedValue(ok({ userId: 'u-1', removed: true })),
      } as Partial<AuthApiClient>,
    });
    const state: NavState = {
      flow: 'accounts',
      step: 'accounts.remove.confirm',
      data: { target: 'u-1' },
    };

    const result = await flow.handle(ctx, state, 'drop:u-1');

    // auth-api has already revoked the session behind that token, so a chat
    // that kept it would answer every later tap with a failed refresh instead
    // of the sign-in offer.
    expect(sessions.clear).toHaveBeenCalledWith(ctx.integration, '5501');
    expect(result.view.id).toBe('accounts.removedSelf');
  });

  it('does not remove anything from a stale keyboard', async () => {
    const { flow, api } = harness();
    // The confirm payload arriving while the state still names the *list*:
    // this is what a keyboard left over from an earlier screen produces.
    const state: NavState = { flow: 'accounts', step: 'accounts.pick', data: {} };

    const result = await flow.handle(ctx, state, 'drop:u-2');

    expect(api.removeAccount).not.toHaveBeenCalled();
    expect(result.view.id).toBe('accounts.remove.confirm');
  });
});
