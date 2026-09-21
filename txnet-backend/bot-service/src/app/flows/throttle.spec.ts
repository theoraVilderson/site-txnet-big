/**
 * A chat the tenant's bot ceiling stopped is offered the app, not a dead end
 * (F-0201-d, ADR-0069).
 *
 * The ceiling is a **shared** budget, so the person it stops is usually not the
 * attacker who spent it — it is the next customer to open the bot. What this
 * file pins is that such a person is handed the one door that still works,
 * and that nobody else is: an ordinary refusal must keep reading as an ordinary
 * refusal, or the Mini App becomes the answer to a wrong password too.
 */
import {
  BOT_THROTTLED_REASON,
  isBotThrottled,
  throttledView,
  throttleOf,
} from './throttle';
import { ACTIONS } from './views';

const URL = 'https://panel.example.com/?ma=telegram';

const refusal = (reason?: string) => ({
  ok: false,
  msg: 'some translated sentence',
  ...(reason ? { error: { reason } } : {}),
});

describe('recognising the ceiling', () => {
  it('knows the reason auth-api names', () => {
    expect(isBotThrottled(refusal(BOT_THROTTLED_REASON))).toBe(true);
  });

  it.each([
    ['a refusal naming no reason at all', refusal()],
    ['a refusal naming a different one', refusal('permissionsChanged')],
    ['a success', { ok: true, msg: '' }],
  ])('leaves %s alone', (_label, result) => {
    expect(isBotThrottled(result)).toBe(false);
  });

  it('never matches on the message, which is already translated', () => {
    // The whole reason `error.reason` exists: `msg` arrives in the user's
    // language, so any match on it is a bug waiting for the next locale.
    expect(isBotThrottled({ ok: false, msg: 'too many requests' })).toBe(false);
  });
});

describe('the screen it produces', () => {
  it('offers the Mini App, because a browser can slide what a chat cannot', () => {
    const view = throttledView(URL);
    const ids = (view.actions ?? []).flat().map((a) => a.id);

    expect(ids).toEqual([ACTIONS.miniApp]);
    expect((view.actions ?? []).flat()[0]).toMatchObject({ kind: 'web_app', url: URL });
  });

  it('drops the button rather than offering one that opens nothing', () => {
    // `PANEL_BASE_URL` is optional; a deployment that has published no panel
    // gets the sentence alone, exactly as `memberMenu` drops its row.
    expect(throttledView(undefined).actions ?? []).toEqual([]);
  });

  it('says its own sentence, not the one written for a browser', () => {
    // `auth.temporarilyLocked` is "wait a while" — correct for a screen with
    // nowhere to go, wrong above a button that goes somewhere.
    expect(throttledView(URL).body).toEqual({ key: 'bot.common.throttled' });
  });
});

describe('throttleOf — what a flow calls', () => {
  it('hands back a screen only for the ceiling', () => {
    expect(throttleOf(refusal(BOT_THROTTLED_REASON), { miniAppUrl: URL })).not.toBeNull();
    expect(throttleOf(refusal(), { miniAppUrl: URL })).toBeNull();
  });
});
