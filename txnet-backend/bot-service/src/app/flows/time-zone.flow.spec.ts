import type { Mocked } from 'vitest';
import { aBotIntegration } from '@txnet-backend/messenger';
import { AuthApiClient } from '../auth-api/auth-api.client';
import { ChatContext, NavState } from '../conversation/nav.types';
import { BotKeys } from '../locale/bot-keys';
import { BotSessionStore } from '../session/bot-session.store';
import { ChatAccess } from '../session/chat-access';
import { ACTIONS, TIME_ZONE_ACTION_PREFIX, TIME_ZONE_CHOICES } from './views';
import { TimeZoneFlow } from './time-zone.flow';

/**
 * Bot settings: the user picks a zone (TZ-1-h, ADR-0108 point 7). The bot
 * holds no zone of its own — every answer is `/auth/me/timezone`'s, so the
 * chat and the panel can never disagree about which clock a user is on.
 *
 * "Same as the panel" is the one choice with a trap in it: `{zone: null,
 * source: 'user'}` clears **whatever** is stored, a browser report included,
 * so sent while the panel's report is in force it would drop the user to the
 * tenant's zone. It is sent only over the user's own choice.
 */
const ctx: ChatContext = { integration: aBotIntegration(), platform: 'telegram', chatId: '5501', senderId: 42, lang: 'fa' };
const ok = <T>(data: T) => ({ ok: true, msg: 'ok', data });
const zoneOf = (timezone: string | null, source: 'user' | 'browser' | null, resolved: { zone: string; from: string }) =>
  ok({ timezone, source, resolved });

function harness(read = zoneOf(null, null, { zone: 'Asia/Tehran', from: 'tenant' }), signedIn = true) {
  const auth = {
    refresh: vi.fn().mockResolvedValue(ok({ accessToken: 'access-1', expiresIn: 900, refreshToken: 'r-next' })),
    myTimeZone: vi.fn().mockResolvedValue(read),
    setMyTimeZone: vi.fn().mockImplementation(async (body: { zone: string | null }) =>
      zoneOf(body.zone, body.zone ? 'user' : null, { zone: body.zone ?? 'Asia/Tehran', from: body.zone ? 'user' : 'tenant' }),
    ),
  } as unknown as Mocked<AuthApiClient>;
  const sessions = {
    get: vi.fn().mockResolvedValue(signedIn ? { refreshToken: 'r-1', signedInAt: 0 } : null),
    save: vi.fn(),
    clear: vi.fn(),
  } as unknown as BotSessionStore;
  return { auth, flow: new TimeZoneFlow(auth, new ChatAccess(auth, sessions)) };
}

const ids = (r: { view: { actions?: { id: string }[][] } }) => (r.view.actions ?? []).flat().map((a) => a.id);
const onPick: NavState = { flow: 'timeZone', step: 'timeZone.pick', data: {} };

describe('TimeZoneFlow', () => {
  it('offers the short list and "same as the panel", saying which clock is in force and why', async () => {
    const { flow } = harness();

    const r = await flow.start(ctx);

    expect(ids(r)).toEqual(
      expect.arrayContaining([...TIME_ZONE_CHOICES.map((z) => `${TIME_ZONE_ACTION_PREFIX}${z}`), ACTIONS.timeZoneFollowPanel]),
    );
    expect(r.view.body.values?.zone).toBe('Asia/Tehran');
    expect(r.view.body.values?.from).toEqual({ key: BotKeys.timeZone.from.tenant });
    expect(r.nextState?.flow).toBe('timeZone');
  });

  it('lists a zone the user is on that the short list lacks, so opening the screen loses nothing', async () => {
    const { flow } = harness(zoneOf('America/Toronto', 'browser', { zone: 'America/Toronto', from: 'browser' }));

    const r = await flow.start(ctx);

    expect(ids(r)).toContain(`${TIME_ZONE_ACTION_PREFIX}America/Toronto`);
  });

  it('saves a pick as the user’s own choice', async () => {
    const { flow, auth } = harness();

    const r = await flow.handle(ctx, onPick, `${TIME_ZONE_ACTION_PREFIX}Europe/Istanbul`);

    expect(auth.setMyTimeZone).toHaveBeenCalledWith(
      { zone: 'Europe/Istanbul', source: 'user' },
      expect.objectContaining({ accessToken: 'access-1', tenantId: ctx.integration.tenantId }),
    );
    expect(r.view.body).toEqual({ key: BotKeys.timeZone.chosen, values: { zone: 'Europe/Istanbul' } });
    expect(r.nextState).toBeNull();
  });

  it('"same as the panel" clears the user’s own choice', async () => {
    const { flow, auth } = harness(zoneOf('Europe/Berlin', 'user', { zone: 'Europe/Berlin', from: 'user' }));

    const r = await flow.handle(ctx, onPick, ACTIONS.timeZoneFollowPanel);

    expect(auth.setMyTimeZone).toHaveBeenCalledWith({ zone: null, source: 'user' }, expect.anything());
    expect(r.view.body).toEqual({ key: BotKeys.timeZone.followsPanel, values: { zone: 'Asia/Tehran' } });
  });

  it('"same as the panel" writes nothing over the panel’s own report — a clear would erase it', async () => {
    const { flow, auth } = harness(zoneOf('America/Toronto', 'browser', { zone: 'America/Toronto', from: 'browser' }));

    const r = await flow.handle(ctx, onPick, ACTIONS.timeZoneFollowPanel);

    expect(auth.setMyTimeZone).not.toHaveBeenCalled();
    expect(r.view.body).toEqual({ key: BotKeys.timeZone.followsPanel, values: { zone: 'America/Toronto' } });
  });

  it('a signed-out chat is told so, and nothing is read', async () => {
    const { flow, auth } = harness(undefined, false);

    const r = await flow.start(ctx);

    expect(r.view.body).toEqual({ key: BotKeys.common.notSignedIn });
    expect(auth.myTimeZone).not.toHaveBeenCalled();
  });

  it('a refusal from auth-api is shown as auth-api worded it', async () => {
    const { flow, auth } = harness();
    auth.setMyTimeZone.mockResolvedValueOnce({ ok: false, msg: 'not a time zone' } as never);

    const r = await flow.handle(ctx, onPick, `${TIME_ZONE_ACTION_PREFIX}Europe/Istanbul`);

    expect(r.view.body).toEqual({ raw: 'not a time zone' });
    expect(r.nextState).toEqual(onPick);
  });
});
