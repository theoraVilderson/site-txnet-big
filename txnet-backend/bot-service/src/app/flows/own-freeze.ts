import { BotText } from '@txnet-backend/messenger';
import type { ApiResult } from '../auth-api/auth-api.types';
import type { MyService } from '../billing-api/services.types';
import { BotKeys } from '../locale/bot-keys';
import { spanUntil } from './span';

/**
 * The user's own freeze in the chat (F-0401-g): the panel's rules
 * (panel-web `contract.own-freeze.md`) over billing's answers, as pure
 * functions — the screen offers what billing would take, and nothing it decides.
 */

/** Billing's refusal of a fourth freeze in 24 hours (billing `contract.gift.md` "Freezing one's own service"). */
const SELF_FREEZE_LIMIT = 'self_freeze_limit';

/**
 * What a service's screen offers (panel rule 1): on a frozen row an unfreeze
 * where billing's `userMayUnfreeze` is true; on a live metered row a freeze.
 * Who may lift it is billing's answer, never re-derived from `freezeMode` — a
 * soft freeze waiting for a panel is support's. A prepaid package, and a row
 * its quota stopped, offer nothing: one frozen by its user would buy free days.
 */
export function ownFreezeOf(s: MyService): 'freeze' | 'unfreeze' | null {
  if (s.frozen) return s.userMayUnfreeze ? 'unfreeze' : null;
  return s.status === 'active' && s.billingMode === 'metered' ? 'freeze' : null;
}

/** Who froze it, said on the screen (panel rule 2), and when a timed freeze lifts; empty on a live row. */
export function frozenNoteOf(s: MyService, now: Date): BotText {
  if (!s.frozen) return { raw: '' };
  const until: BotText = s.frozenUntil
    ? { key: BotKeys.services.frozenUntil, values: { left: spanUntil(new Date(s.frozenUntil).getTime(), now.getTime(), BotKeys.services.left) } }
    : { raw: '' };
  if (!s.userMayUnfreeze) return { key: BotKeys.services.frozenBy.hard, values: { until } };
  return { key: s.freezeMode === 'self' ? BotKeys.services.frozenBy.self : BotKeys.services.frozenBy.soft, values: { until } };
}

/**
 * A refused freeze in the chat's words: the daily cap names how many and when
 * the next is allowed (panel rule 6, from billing's `facts`); any other is
 * billing's own sentence (panel rule 7), so the bot never words a rule it does not hold.
 */
export function freezeRefusalOf(answer: ApiResult<unknown>, now: Date): BotText {
  const facts = answer.error?.facts;
  if (answer.error?.reason === SELF_FREEZE_LIMIT && facts) {
    const left = spanUntil(Number(facts.nextAtMs), now.getTime(), BotKeys.services.left);
    return { key: BotKeys.services.freezeLimited, values: { limit: Number(facts.limit), left } };
  }
  return { raw: answer.msg };
}
