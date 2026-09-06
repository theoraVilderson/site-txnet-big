import { BotAction, BotText, BotView } from '@txnet-backend/messenger';

/**
 * The screens shared by every flow. They are `BotView`s — keys and choices,
 * never a Telegram payload and never a sentence.
 */

export const ACTIONS = {
  login: 'menu:login',
  loginPassword: 'login:password',
  loginOtp: 'login:otp',
  register: 'menu:register',
  forgot: 'menu:forgot',
  logout: 'menu:logout',
  accounts: 'menu:accounts',
  accountAdd: 'accounts:add',
  accountRemove: 'accounts:remove',
  addWithOtp: 'add:otp',
  addWithPassword: 'add:password',
  cancel: 'nav:cancel',
  back: 'nav:back',
  menu: 'nav:menu',
  help: 'nav:help',
  language: 'nav:lang',
  resend: 'otp:resend',
  shareContact: 'contact:share',
  linkCheck: 'link:check',
  linkOpen: 'link:open',
} as const;

export const cancel: BotAction = {
  id: ACTIONS.cancel,
  label: { key: 'bot.action.cancel' },
};

export const back: BotAction = {
  id: ACTIONS.back,
  label: { key: 'bot.action.back' },
};

/** `lang:fa`, `lang:en` — the code is the payload, so no table maps them. */
export const LANGUAGE_ACTION_PREFIX = 'lang:';

/**
 * `account:<userId>` — which member of the group to become (`F-0210`).
 *
 * The id is the payload for the same reason the language code is: the set is
 * per-user and built at render time, so no table could map it. It is not a
 * secret and it is not a credential — `auth-api` decides whether the caller
 * may become it, and a user id belonging to someone else's group is refused
 * there (`accountSwitch.notAMember`), not here.
 */
export const ACCOUNT_ACTION_PREFIX = 'account:';

/**
 * `drop:<userId>` — which member to remove from this chat's group (`F-0208`).
 *
 * A second prefix rather than a mode flag on `account:` because the two
 * answers arrive on the same screen shape and are read by the same handler:
 * one tap means "become this account" and the other means "remove it", and a
 * payload that has to be read together with remembered state to tell which is
 * exactly how a stale screen ends up removing an account someone meant to
 * switch to.
 */
export const REMOVE_ACTION_PREFIX = 'drop:';

/** Start `F-0205`'s proof conversation from the account list. */
export const addAccount: BotAction = {
  id: ACTIONS.accountAdd,
  label: { key: 'bot.action.addAccount' },
};

/** Open the "which one should go?" screen (`F-0208`). */
export const removeAccount: BotAction = {
  id: ACTIONS.accountRemove,
  label: { key: 'bot.action.removeAccount' },
};

export const toMenu: BotAction = {
  id: ACTIONS.menu,
  label: { key: 'bot.action.menu' },
};

export function view(
  id: string,
  body: BotText,
  actions: BotAction[][] = [],
): BotView {
  return { id, body, actions };
}

/**
 * The signed-out menu: the two things an anonymous chat can do, plus the way
 * to ask what any of it means. Sign-in leads, because a returning user is the
 * common case and a returning user should not have to read three options.
 */
export function guestMenu(): BotView {
  return view('menu.guest', { key: 'bot.menu.guest' }, [
    [{ id: ACTIONS.login, label: { key: 'bot.action.login' } }],
    [{ id: ACTIONS.register, label: { key: 'bot.action.register' } }],
    [{ id: ACTIONS.forgot, label: { key: 'bot.action.forgot' } }],
    [
      { id: ACTIONS.help, label: { key: 'bot.action.help' } },
      { id: ACTIONS.language, label: { key: 'bot.action.language' } },
    ],
  ]);
}

/** The signed-in menu. Everything past sign-out arrives with §10.4's own rows. */
export function memberMenu(): BotView {
  return view('menu.member', { key: 'bot.menu.member' }, [
    [{ id: ACTIONS.accounts, label: { key: 'bot.action.accounts' } }],
    [
      { id: ACTIONS.help, label: { key: 'bot.action.help' } },
      { id: ACTIONS.language, label: { key: 'bot.action.language' } },
    ],
    [{ id: ACTIONS.logout, label: { key: 'bot.action.logout' } }],
  ]);
}

/**
 * The switch group as one screen (`F-0210`): who this chat is, and who else it
 * may become in one tap.
 *
 * The current account is a line of text rather than a button — it is where the
 * user already is, and a button that does nothing is worse than no button. The
 * masked phone rides along in the label because two accounts belonging to one
 * person are routinely named the same thing, which is the exact case this
 * screen exists to disambiguate.
 *
 * Adding an account is the last row, and it is the same row whether the group
 * exists yet or not: a chat with one account and a chat with four reach
 * `F-0205` by the same button, because "add" is not a special case of "empty".
 */
export function accountsView(
  current: { fullName: string; phoneMasked: string | null },
  members: Array<{ userId: string; fullName: string; phoneMasked: string | null }>,
): BotView {
  if (!members.length) {
    return view(
      'accounts.none',
      {
        key: 'bot.accounts.none',
        values: { name: current.fullName },
      },
      [[addAccount], [toMenu]],
    );
  }
  return view(
    'accounts.list',
    { key: 'bot.accounts.pick', values: { name: current.fullName } },
    [
      ...members.map((m) => [
        {
          id: `${ACCOUNT_ACTION_PREFIX}${m.userId}`,
          label: {
            key: m.phoneMasked ? 'bot.accounts.member' : 'bot.accounts.memberNoPhone',
            values: { name: m.fullName, phone: m.phoneMasked ?? '' },
          },
        },
      ]),
      [addAccount],
      // Only offered once there is something to remove — an empty group takes
      // the `accounts.none` branch above and never reaches here.
      [removeAccount],
      [cancel],
    ],
  );
}

/**
 * Which member to remove (`F-0208`).
 *
 * The caller's own account is on this list, last, and that is deliberate:
 * F-0208 is "from either side", so leaving a group you were added to is the
 * same screen as removing someone from one you built. Hiding the self row
 * would leave the account that was *added* with no way out of a group it did
 * not create, which is the lock-in the feature exists to remove.
 */
export function removeAccountsView(
  current: { userId: string; fullName: string; phoneMasked: string | null },
  members: Array<{ userId: string; fullName: string; phoneMasked: string | null }>,
): BotView {
  const row = (m: { userId: string; fullName: string; phoneMasked: string | null }) => [
    {
      id: `${REMOVE_ACTION_PREFIX}${m.userId}`,
      label: {
        key: m.phoneMasked ? 'bot.accounts.member' : 'bot.accounts.memberNoPhone',
        values: { name: m.fullName, phone: m.phoneMasked ?? '' },
      },
    },
  ];

  return view(
    'accounts.remove.pick',
    { key: 'bot.accounts.removePick' },
    [
      ...members.map(row),
      [
        {
          id: `${REMOVE_ACTION_PREFIX}${current.userId}`,
          label: { key: 'bot.accounts.removeSelf', values: { name: current.fullName } },
        },
      ],
      [cancel],
    ],
  );
}

/**
 * The confirm step (`F-0208`).
 *
 * Removal is cheap to undo for an account you can still prove — you add it
 * again — but it also signs that account out of this chat, and the tap that
 * causes it sits one row away from the tap that switches to it. One
 * confirmation is the difference between an inconvenience and a surprise.
 */
export function removeConfirmView(
  target: { userId: string; fullName: string },
  isSelf: boolean,
): BotView {
  return view(
    'accounts.remove.confirm',
    {
      key: isSelf ? 'bot.accounts.removeConfirmSelf' : 'bot.accounts.removeConfirm',
      values: { name: target.fullName },
    },
    [
      [
        {
          id: `${REMOVE_ACTION_PREFIX}${target.userId}`,
          label: { key: 'bot.action.confirmRemove' },
        },
      ],
      [cancel],
    ],
  );
}

/**
 * The two proofs `F-0205` accepts, as one screen (`F-0210`'s missing half).
 *
 * They are offered as a *choice* rather than one path with the other as a
 * fallback: the account being added is a real account whose owner is sitting
 * in this chat, so either its own code or its own password settles the
 * question, and which one is cheaper depends on where that person is. The
 * panel asks it as two tabs (`accounts/add/page.tsx`) — same question, same
 * order, so a user who has done it once on the site recognises it here.
 *
 * What is never offered is adding an account by naming it. The credential
 * asked for on this screen is the entire reason a switch afterwards asks for
 * none.
 */
export function addProofView(): BotView {
  return ask('accountAdd.method', { key: 'bot.accounts.addPickProof' }, [
    [{ id: ACTIONS.addWithOtp, label: { key: 'bot.action.addWithOtp' } }],
    [{ id: ACTIONS.addWithPassword, label: { key: 'bot.action.addWithPassword' } }],
  ]);
}

/**
 * What this bot can do and what the four commands mean.
 *
 * A chat interface has no affordances of its own: nothing on screen says that
 * `/menu` exists or that a conversation can be abandoned halfway. Rather than
 * hoping the user guesses, the bot answers the question outright — and offers
 * it as a button, because a user who does not know `/help` exists cannot type
 * it either.
 */
/**
 * Which language to be spoken to in.
 *
 * The labels are each language's **own** native name, never a translation of
 * it: someone looking for Persian is looking for the word "فارسی", and a user
 * who cannot read the current language must still be able to find their way
 * out of it. That is also why this screen is reachable from both menus, from
 * `/lang`, and from the messenger's command list.
 */
export function languageView(
  locales: Array<{ code: string; nativeName: string }>,
  current: string,
): BotView {
  return view('language', { key: 'bot.language.pick' }, [
    ...locales.map((l) => [
      {
        id: `${LANGUAGE_ACTION_PREFIX}${l.code}`,
        label: { raw: l.code === current ? `${l.nativeName} ✅` : l.nativeName },
      },
    ]),
    [cancel],
  ]);
}

export function helpView(): BotView {
  return view('help', { key: 'bot.help.body' }, [[toMenu]]);
}

/**
 * A statement, with no keyboard.
 *
 * A view built this way is *never* the last thing a user sees: the router
 * attaches the menu to whatever ends a conversation (`decorate`). A screen
 * that says something and offers nothing is a dead end, and a dead end in a
 * chat is indistinguishable from a bot that has crashed.
 */
export function say(id: string, body: BotText): BotView {
  return { id, body, clearKeyboard: true };
}

/** A question with a Cancel next to it — every step of every flow has one. */
export function ask(id: string, body: BotText, extra: BotAction[][] = []): BotView {
  return view(id, body, [...extra, [cancel]]);
}

/**
 * Asks the platform for the sender's own contact card.
 *
 * Cancel rides along on the same keyboard: this is the one screen a user is
 * most likely to refuse outright, and until the renderer kept the other rows
 * it was also the one screen with no visible way out.
 */
export function askContact(id: string, body: BotText): BotView {
  return view(id, body, [
    [
      {
        id: ACTIONS.shareContact,
        kind: 'contact',
        label: { key: 'bot.action.shareContact' },
      },
    ],
    [cancel],
  ]);
}
