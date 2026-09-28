import { BotText } from '@txnet-backend/messenger';
import { OtpChannelName } from '../auth-api/auth-api.types';
import { BotFlow, NavState } from '../conversation/nav.types';
import { BotKey, BotKeys } from '../locale/bot-keys';
import { money } from '../locale/money';

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
  // The reseller panel is a set of screens a person moves around in, not a
  // conversation with an end: the list, one customer, the figure. There is no
  // last step to count towards, so it counts nothing — same as `accounts`.
  reseller: [],
  topUp: ['topUp.gateway', 'topUp.amount', 'topUp.confirm'],
  // The broadcast *is* a conversation with an end (F-313-b): who it goes to,
  // what it says, and the tap that sends it. What follows the send — the
  // status screen and the list of past ones — is not a step towards anything,
  // and lands outside this list, which `progressOf` reads as nothing to count.
  campaign: ['campaign.segment', 'campaign.text', 'campaign.confirm'],
};

/**
 * "Create an account · step 3 of 6".
 *
 * One key per flow rather than one key plus an interpolated flow name: a
 * template cannot hold another template, and a Persian sentence that reads
 * naturally is not the English one with a word swapped in.
 *
 * An exhaustive `Record` rather than `` `bot.progress.${flow}` `` (C-07): a new
 * flow does not compile without a row, and a renamed key does not compile at
 * all. `null` is a flow with nothing to count (`accounts`, see `FLOW_STEPS`).
 */
export const PROGRESS_KEY: Record<BotFlow, BotKey | null> = {
  login: BotKeys.progress.login,
  register: BotKeys.progress.register,
  forgot: BotKeys.progress.forgot,
  accountAdd: BotKeys.progress.accountAdd,
  accounts: null,
  reseller: null,
  topUp: BotKeys.progress.topUp,
  campaign: BotKeys.progress.campaign,
};

export function progressOf(state: NavState): BotText | undefined {
  const key = PROGRESS_KEY[state.flow];
  const steps = stepsOf(state);
  const at = steps.indexOf(state.step);
  if (!key || at < 0) return undefined;
  return {
    key,
    values: { n: at + 1, total: steps.length },
  };
}

/** The summary line for the channel a code was sent to. */
export const CHANNEL_SUMMARY_KEY: Record<OtpChannelName, BotKey> = {
  sms: BotKeys.field.channel.sms,
  telegram: BotKeys.field.channel.telegram,
  bale: BotKeys.field.channel.bale,
};

/**
 * The fields worth echoing, in the order they are asked for. A password is
 * absent on purpose — it is never in `data` (`ConversationStore` strips it)
 * and repeating it back would undo the deletion it just got.
 */
const ECHOED: Array<{ field: string; key: string }> = [
  { field: 'phoneNumber', key: BotKeys.field.phone },
  { field: 'identifier', key: BotKeys.field.identifier },
  { field: 'fullName', key: BotKeys.field.name },
  { field: 'username', key: BotKeys.field.username },
  // F-306-a. What was picked and typed — never a price, which is billing's to say.
  { field: 'gateway', key: BotKeys.field.gateway },
  { field: 'amount', key: BotKeys.field.amount },
];

/** Echoed with the currency the gateway named (F-116-h4), rather than as typed. */
const MONEY_FIELDS = new Set(['amount']);

/** What the user has told this conversation so far, one line each. */
export function summaryOf(state: NavState): BotText[] {
  const lines: BotText[] = [];
  for (const { field, key } of ECHOED) {
    const value = state.data[field];
    if (value) lines.push({ key, values: { value: MONEY_FIELDS.has(field) ? money(value, state.data.currencyCode) : value } });
  }
  // The channel is a choice, not typed text: its own key, so "Here, in this
  // chat" reads the same in the summary as it did on the button.
  const channel = state.data.channel as OtpChannelName | undefined;
  if (channel && Object.prototype.hasOwnProperty.call(CHANNEL_SUMMARY_KEY, channel)) {
    lines.push({ key: CHANNEL_SUMMARY_KEY[channel] });
  }
  return lines;
}
