import { SUGGESTION_OPT_OUT_PREFIX } from '@txnet-backend/shared-core';

import { BotKeys } from '../locale/bot-keys';
import { SuggestionOptOut } from './suggestion-opt-out';

/**
 * F-038-g4 (F-1505, ADR-0109 point 10): "don't show this again" under an AI
 * suggestion in the bot. One tap, permanent, per action type.
 *
 * The failures worth a spec: opting out a user other than the one tapping —
 * the button names an action, never a person, so who it is comes from the
 * chat's own signed-in session; a session of another tenant than this bot's;
 * a tap from a signed-out chat or with a garbled payload reaching ai at all;
 * and a stale button (an action of someone else, or gone) answered as done.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '44444444-4444-4444-8444-444444444444';
const ACTION = '77777777-7777-4777-8777-777777777777';

const ctx = { chatId: '5501', lang: 'fa', platform: 'telegram', integration: { tenantId: TENANT } } as never;

function build(over: { token?: string | null; me?: unknown; ai?: { ok: boolean; status: number; actionType?: string } } = {}) {
  const access = { token: vi.fn(async () => (over.token === undefined ? 'access' : over.token)) };
  const api = { me: vi.fn(async () => over.me ?? { ok: true, data: { userId: USER, tenant: { id: TENANT } } }) };
  const ai = { optOut: vi.fn(async () => over.ai ?? { ok: true, status: 200, actionType: 'renew' }) };
  return { access, api, ai, flow: new SuggestionOptOut(access as never, api as never, ai as never) };
}

describe('SuggestionOptOut (F-038-g4)', () => {
  it('opts out the signed-in user of this chat, in this bot’s tenant', async () => {
    const { flow, ai } = build();
    const out = await flow.tap(ctx, `${SUGGESTION_OPT_OUT_PREFIX}${ACTION}`);
    expect(ai.optOut).toHaveBeenCalledWith(ACTION, { tenantId: TENANT, subjectKind: 'user', subjectId: USER });
    expect(out.view.body).toMatchObject({ key: BotKeys.suggestion.optedOut });
    expect(out.nextState).toBeNull();
  });

  it('a signed-out chat, or a garbled payload, never reaches ai', async () => {
    for (const [over, data] of [
      [{ token: null }, `${SUGGESTION_OPT_OUT_PREFIX}${ACTION}`],
      [{}, `${SUGGESTION_OPT_OUT_PREFIX}not-a-uuid`],
    ] as const) {
      const { flow, ai } = build(over);
      await flow.tap(ctx, data);
      expect(ai.optOut).not.toHaveBeenCalled();
    }
  });

  it('refuses a session of another tenant than this bot', async () => {
    const { flow, ai } = build({ me: { ok: true, data: { userId: USER, tenant: { id: '22222222-2222-4222-8222-222222222222' } } } });
    const out = await flow.tap(ctx, `${SUGGESTION_OPT_OUT_PREFIX}${ACTION}`);
    expect(ai.optOut).not.toHaveBeenCalled();
    expect(out.view.body).toMatchObject({ key: BotKeys.suggestion.gone });
  });

  it('a stale button — not this user’s action, or gone — says so, not done', async () => {
    const { flow } = build({ ai: { ok: false, status: 404 } });
    const out = await flow.tap(ctx, `${SUGGESTION_OPT_OUT_PREFIX}${ACTION}`);
    expect(out.view.body).toMatchObject({ key: BotKeys.suggestion.gone });
  });
});
