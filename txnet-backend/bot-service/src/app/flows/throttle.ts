import { BotView } from '@txnet-backend/messenger';
import { ApiResult } from '../auth-api/auth-api.types';
import { ChatContext } from '../conversation/nav.types';
import { BotKeys } from '../locale/bot-keys';
import { miniApp, say } from './views';

/**
 * The tenant's bot ceiling refused this call — and where the user goes instead.
 *
 * `BOT_UNPROVEN` bounds the captcha waiver ADR-0011 granted, across the gated
 * routes. Since ADR-0070 the budget is the **chat's own**, so the chat this
 * refusal stops is the one that spent it — no customer is refused for somebody
 * else's traffic any more. The offer stays anyway: a chat that has honestly run
 * out of attempts has somewhere better to go than a wait.
 *
 * The Mini App is the answer because of what it *is*, not as a consolation: it
 * is a browser, so it can carry the slide a chat cannot, and it signs itself in
 * from the platform's own signature (ADR-0017) rather than through a gated
 * route. So the door this refusal closes is the one door the offer does not use.
 *
 * `error.reason` is the only thing branched on here. `msg` is already
 * translated and matching it would break in the next language; the status code
 * is not read at all, which is `AuthApiClient`'s own rule (ADR-0009). A refusal
 * naming no reason is an ordinary refusal and never reaches this file.
 */
export const BOT_THROTTLED_REASON = 'botTrafficThrottled';

export function isBotThrottled(result: ApiResult<unknown>): boolean {
  return !result.ok && result.error?.reason === BOT_THROTTLED_REASON;
}

/**
 * The refusal as a screen: our own sentence, plus the app when there is one.
 *
 * Deliberately **not** `result.msg`. That is `auth.temporarilyLocked`, written
 * for a browser that has nowhere else to go; here the sentence has to explain
 * the button under it. A deployment with no `PANEL_BASE_URL` has no button and
 * gets the sentence alone, the same way `memberMenu` drops the row.
 */
export function throttledView(miniAppUrl?: string): BotView {
  const view = say('auth.throttled', { key: BotKeys.common.throttled });
  return miniAppUrl
    ? { ...view, actions: [[miniApp(miniAppUrl)]] }
    : view;
}

/** True when this refusal is the ceiling's, for the flows to branch on once. */
export function throttleOf(
  result: ApiResult<unknown>,
  ctx: Pick<ChatContext, 'miniAppUrl'>,
): BotView | null {
  return isBotThrottled(result) ? throttledView(ctx.miniAppUrl) : null;
}
