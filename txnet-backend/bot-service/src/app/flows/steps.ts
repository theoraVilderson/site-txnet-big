import { BotText } from '@txnet-backend/messenger';
import { BotFlow, NavState } from '../conversation/nav.types';

/**
 * Where a conversation is, and what the user has already said.
 *
 * None of this is a rule — it is orientation. A chat has no title bar, no
 * progress bar and no form to scroll back up through, so a bot that asks six
 * questions in a row without ever saying *which* six is a bot the user gets
 * lost in. Every line below is built from keys (`F-317`: a tenant may reword
 * all of it) and applied centrally by the router, so no flow spells out where
 * it is and no future flow can forget to.
 */

/**
 * The questions each flow asks, in order.
 *
 * `login` genuinely forks — a password needs two answers, a one-time code
 * needs three — so the branch the user picked chooses the list. A count that
 * lied ("step 2 of 4" when two of the four cannot happen) would be worse than
 * no count at all.
 */
export function stepsOf(state: NavState): string[] {
  if (state.flow === 'login') {
    // The fast path (ADR-0012) is one question long — the contact card — and
    // only exists for a chat that has one to give, so it is its own list
    // rather than a step nobody else can reach.
    if (state.step === 'login.chat') return ['login.chat'];
    return state.data.method === 'password'
      ? ['login.method', 'login.identifier', 'login.password']
      : ['login.method', 'login.phone', 'login.channel', 'login.code'];
  }
  // Adding an account forks for the same reason login does, and the fork is
  // the feature: `F-0205` accepts two proofs and lets the caller pick.
  if (state.flow === 'accountAdd') {
    return state.data.proof === 'password'
      ? ['accountAdd.method', 'accountAdd.identifier', 'accountAdd.password']
      : ['accountAdd.method', 'accountAdd.phone', 'accountAdd.channel', 'accountAdd.code'];
  }
  return FLOW_STEPS[state.flow];
}

const FLOW_STEPS: Record<Exclude<BotFlow, 'login' | 'accountAdd'>, string[]> = {
  register: [
    'register.phone',
    'register.name',
    'register.username',
    'register.channel',
    'register.password',
    'register.code',
  ],
  forgot: ['forgot.phone', 'forgot.channel', 'forgot.code', 'forgot.password'],
  // Switching accounts is one screen, not a conversation: there is nothing to
  // count and "step 1 of 1" is noise on a screen that is already a list. An
  // empty list makes `progressOf` return nothing, which is the honest answer.
  accounts: [],
};

/**
 * "Create an account · step 3 of 6".
 *
 * One key per flow rather than one key plus an interpolated flow name: a
 * template cannot hold another template, and a Persian sentence that reads
 * naturally is not the English one with a word swapped in.
 */
export function progressOf(state: NavState): BotText | undefined {
  const steps = stepsOf(state);
  const at = steps.indexOf(state.step);
  if (at < 0) return undefined;
  return {
    key: `bot.progress.${state.flow}`,
    values: { n: at + 1, total: steps.length },
  };
}

/**
 * The fields worth echoing, in the order they are asked for. A password is
 * absent on purpose — it is never in `data` (`ConversationStore` strips it)
 * and repeating it back would undo the deletion it just got.
 */
const ECHOED: Array<{ field: string; key: string }> = [
  { field: 'phoneNumber', key: 'bot.field.phone' },
  { field: 'identifier', key: 'bot.field.identifier' },
  { field: 'fullName', key: 'bot.field.name' },
  { field: 'username', key: 'bot.field.username' },
];

/** What the user has told this conversation so far, one line each. */
export function summaryOf(state: NavState): BotText[] {
  const lines: BotText[] = [];
  for (const { field, key } of ECHOED) {
    const value = state.data[field];
    if (value) lines.push({ key, values: { value } });
  }
  // The channel is a choice, not typed text: its own key, so "Here, in this
  // chat" reads the same in the summary as it did on the button.
  if (state.data.channel) {
    lines.push({ key: `bot.field.channel.${state.data.channel}` });
  }
  return lines;
}
