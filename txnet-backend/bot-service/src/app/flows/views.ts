import { BotAction, BotText, BotView } from '@txnet-backend/messenger';
import { BotKeys } from '../locale/bot-keys';

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
  /**
   * `F-0211`. Not on the member menu on purpose (ADR-0035): it is reached from
   * the accounts screen, where the user is already looking at the set it ends,
   * and it asks before it acts. Two ids, because the asking is the point.
   */
  logoutAllAsk: 'accounts:logoutAll',
  logoutAll: 'accounts:logoutAll:confirm',
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
  miniApp: 'menu:miniapp',
  topUp: 'menu:topup',
  topUpPay: 'topup:pay',
  /** The reseller management panel (`F-311-c`) — the menu row, and its two screens. */
  reseller: 'menu:reseller',
  resellerUsers: 'reseller:users',
  resellerRevenue: 'reseller:revenue',
  /** Drop the search and go back to the whole list. */
  resellerAllUsers: 'reseller:users:all',
} as const;

export const cancel: BotAction = {
  id: ACTIONS.cancel,
  label: { key: BotKeys.action.cancel },
};

export const back: BotAction = {
  id: ACTIONS.back,
  label: { key: BotKeys.action.back },
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
  label: { key: BotKeys.action.addAccount },
};

/** Open the "which one should go?" screen (`F-0208`). */
export const removeAccount: BotAction = {
  id: ACTIONS.accountRemove,
  label: { key: BotKeys.action.removeAccount },
};

/**
 * `ruser:<userId>` — which of the reseller's users to open (`F-311-c`).
 *
 * A prefix for the same reason the account list has one: the set is built at
 * render time out of whatever page the reseller is looking at, so no table
 * could map it. It is not a credential — `auth-api` decides whether this
 * caller may read or touch that user, and a user id from another tenant is
 * answered `user_not_found` there (`contract.reseller-users.md`), not here.
 */
export const RESELLER_USER_PREFIX = 'ruser:';

/**
 * `rpage:<n>` — which page of the list to draw.
 *
 * The page is on the button rather than in the conversation state because a
 * chat holds two screens at once routinely: the one just sent and the one
 * three messages up. A page read from remembered state would mean an older
 * keyboard pages the newer screen.
 */
export const RESELLER_PAGE_PREFIX = 'rpage:';

/**
 * `rblock:<userId>` / `runblock:<userId>` — the two write buttons.
 *
 * Two prefixes rather than one with a mode, exactly as `drop:` is a second
 * prefix beside `account:`: blocking and unblocking arrive on the same screen
 * shape, and a payload that has to be read together with remembered state to
 * tell which is how a stale keyboard blocks someone it meant to unblock.
 */
export const RESELLER_BLOCK_PREFIX = 'rblock:';
export const RESELLER_UNBLOCK_PREFIX = 'runblock:';

export const toMenu: BotAction = {
  id: ACTIONS.menu,
  label: { key: BotKeys.action.menu },
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
  return view('menu.guest', { key: BotKeys.menu.guest }, [
    [{ id: ACTIONS.login, label: { key: BotKeys.action.login } }],
    [{ id: ACTIONS.register, label: { key: BotKeys.action.register } }],
    [{ id: ACTIONS.forgot, label: { key: BotKeys.action.forgot } }],
    [
      { id: ACTIONS.help, label: { key: BotKeys.action.help } },
      { id: ACTIONS.language, label: { key: BotKeys.action.language } },
    ],
  ]);
}

/**
 * The Mini App as a choice on a menu (`F-310`).
 *
 * `kind: 'web_app'` is intent, not a widget: a platform that has the surface
 * opens the panel inside the messenger, and one that does not gets the same
 * URL as an ordinary link (`messenger`'s degradation table). Either way the
 * page it opens signs itself in from the platform's own signature, so this is
 * one tap and not a second login.
 *
 * It is a *row on the menu* rather than a `BotView.escape`, and the difference
 * is deliberate. An `escape` says "this screen is done better on the web",
 * which is a claim about a specific screen; the Mini App is a destination of
 * its own, offered where the other destinations are. Chat-first is untouched
 * either way (ADR-0009): nothing below this row moved into it.
 */
/**
 * The query parameter the Mini App URL carries, and the panel's half of it
 * (`site-pwa/src/lib/mini-app.ts`).
 *
 * It names the messenger, because the page cannot tell: each platform serves
 * its own WebApp script and injects nothing until that script is loaded, so a
 * panel with no marker loaded neither and had no signature to sign in with.
 * A hint, not a credential — the server still verifies the signature itself.
 */
export const MINI_APP_PARAM = 'ma';

export function miniApp(url: string): BotAction {
  return {
    id: ACTIONS.miniApp,
    kind: 'web_app',
    url,
    label: { key: BotKeys.action.miniApp },
  };
}

/**
 * The signed-in menu. Everything past sign-out arrives with §10.4's own rows.
 *
 * `miniAppUrl` is optional because `PANEL_BASE_URL` is: a deployment that has
 * not published a panel yet shows a menu without the row, rather than a button
 * that opens nothing.
 */
export function memberMenu(miniAppUrl?: string, topUp = false, reseller = false): BotView {
  return view('menu.member', { key: BotKeys.menu.member }, [
    ...(miniAppUrl ? [[miniApp(miniAppUrl)]] : []),
    // F-306-a. Only where billing is reachable (`BillingApiClient.isConfigured`).
    ...(topUp ? [[{ id: ACTIONS.topUp, label: { key: BotKeys.action.topUp } }]] : []),
    // F-311-c. The row exists only for a chat the **door** says may administer
    // this bot's reseller (`GET /api/tenants/:id/access`, F-311-e) — never on
    // a rule of the bot's own, and never for the customers this same bot
    // serves, who are the majority of the chats that reach this line.
    ...(reseller ? [[{ id: ACTIONS.reseller, label: { key: BotKeys.action.reseller } }]] : []),
    [{ id: ACTIONS.accounts, label: { key: BotKeys.action.accounts } }],
    [
      { id: ACTIONS.help, label: { key: BotKeys.action.help } },
      { id: ACTIONS.language, label: { key: BotKeys.action.language } },
    ],
    [{ id: ACTIONS.logout, label: { key: BotKeys.action.logout } }],
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
        key: BotKeys.accounts.none,
        values: { name: current.fullName },
      },
      [[addAccount], [toMenu]],
    );
  }
  return view(
    'accounts.list',
    { key: BotKeys.accounts.pick, values: { name: current.fullName } },
    [
      ...members.map((m) => [
        {
          id: `${ACCOUNT_ACTION_PREFIX}${m.userId}`,
          label: {
            key: m.phoneMasked ? BotKeys.accounts.member : BotKeys.accounts.memberNoPhone,
            values: { name: m.fullName, phone: m.phoneMasked ?? '' },
          },
        },
      ]),
      [addAccount],
      // Only offered once there is something to remove — an empty group takes
      // the `accounts.none` branch above and never reaches here.
      [removeAccount],
      // Last row, and only where a group exists: signing out of *everything*
      // belongs beside the set it ends, not on the menu next to the ordinary
      // sign-out (ADR-0035). It asks before it acts.
      [signOutAll],
      [cancel],
    ],
  );
}

/** The one confirmation the accounts screen insists on (`F-0211`). */
export const signOutAll: BotAction = {
  id: ACTIONS.logoutAllAsk,
  label: { key: BotKeys.action.signOutAll },
};

/**
 * "Really sign out of all of them?" — a screen, because an inline keyboard has
 * no other way to ask. The confirming button carries its own id, so a stale
 * tap on the previous screen can never be read as a yes.
 */
export function signOutAllConfirmView(): BotView {
  return view('accounts.signOutAll', { key: BotKeys.accounts.signOutAllAsk }, [
    [{ id: ACTIONS.logoutAll, label: { key: BotKeys.action.signOutAllYes } }],
    [cancel],
  ]);
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
        key: m.phoneMasked ? BotKeys.accounts.member : BotKeys.accounts.memberNoPhone,
        values: { name: m.fullName, phone: m.phoneMasked ?? '' },
      },
    },
  ];

  return view(
    'accounts.remove.pick',
    { key: BotKeys.accounts.removePick },
    [
      ...members.map(row),
      [
        {
          id: `${REMOVE_ACTION_PREFIX}${current.userId}`,
          label: { key: BotKeys.accounts.removeSelf, values: { name: current.fullName } },
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
      key: isSelf ? BotKeys.accounts.removeConfirmSelf : BotKeys.accounts.removeConfirm,
      values: { name: target.fullName },
    },
    [
      [
        {
          id: `${REMOVE_ACTION_PREFIX}${target.userId}`,
          label: { key: BotKeys.action.confirmRemove },
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
  return ask('accountAdd.method', { key: BotKeys.accounts.addPickProof }, [
    [{ id: ACTIONS.addWithOtp, label: { key: BotKeys.action.addWithOtp } }],
    [{ id: ACTIONS.addWithPassword, label: { key: BotKeys.action.addWithPassword } }],
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
  return view('language', { key: BotKeys.language.pick }, [
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
  return view('help', { key: BotKeys.help.body }, [[toMenu]]);
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
        label: { key: BotKeys.action.shareContact },
      },
    ],
    [cancel],
  ]);
}

/**
 * The reseller panel's own menu (`F-311-c`): the two things it can answer.
 *
 * A screen of its own rather than two more rows on the member menu, because
 * this bot serves the reseller's *customers* too — everything below this point
 * is about the business, and a member menu that mixes "top up my wallet" with
 * "block a customer" makes the reseller read their own menu twice.
 */
export function resellerMenu(): BotView {
  return view('reseller.home', { key: BotKeys.reseller.home }, [
    [{ id: ACTIONS.resellerUsers, label: { key: BotKeys.action.resellerUsers } }],
    [{ id: ACTIONS.resellerRevenue, label: { key: BotKeys.action.resellerRevenue } }],
    [toMenu],
  ]);
}

/** One page of the reseller's users, as `auth-api` answered it. */
export interface ResellerUserRow {
  id: string;
  fullName: string;
  phoneMasked: string | null;
}

/**
 * The customer list (`F-311-c`), with search and paging on the same screen.
 *
 * **Typing is the search box.** A chat has no other one, so free text on this
 * screen is a query and a tap is a customer — which is why the empty-search
 * and the no-match screens are different sentences: "nobody has signed up" is
 * a fact about the reseller, "nothing matches" is a fact about what they typed,
 * and answering the second with the first reads as the list having been lost.
 *
 * Paging is `rpage:<n>` buttons rather than a remembered cursor: the page
 * count comes from `total` and `pageSize`, both of which `auth-api` answered,
 * so this screen computes no offset of its own.
 */
export function resellerUsersView(
  page: { items: ResellerUserRow[]; total: number; page: number; pageSize: number },
  q: string | undefined,
): BotView {
  if (!page.items.length) {
    return view(
      q ? 'reseller.users.noMatch' : 'reseller.users.empty',
      q
        ? { key: BotKeys.reseller.usersNoMatch, values: { q } }
        : { key: BotKeys.reseller.usersEmpty },
      q ? [[allResellerUsers], [toMenu]] : [[toMenu]],
    );
  }

  const pages = Math.ceil(page.total / page.pageSize);
  const paging: BotAction[] = [
    ...(page.page > 1
      ? [{ id: `${RESELLER_PAGE_PREFIX}${page.page - 1}`, label: { key: BotKeys.action.resellerPrevPage } }]
      : []),
    ...(page.page < pages
      ? [{ id: `${RESELLER_PAGE_PREFIX}${page.page + 1}`, label: { key: BotKeys.action.resellerNextPage } }]
      : []),
  ];

  return view(
    'reseller.users',
    {
      key: BotKeys.reseller.usersPick,
      values: { shown: String(page.items.length), total: String(page.total) },
    },
    [
      ...page.items.map((u) => [
        {
          id: `${RESELLER_USER_PREFIX}${u.id}`,
          label: {
            key: u.phoneMasked ? BotKeys.reseller.userRow : BotKeys.reseller.userRowNoPhone,
            values: { name: u.fullName, phone: u.phoneMasked ?? '' },
          },
        },
      ]),
      ...(paging.length ? [paging] : []),
      // Only where a search narrowed it: on the whole list this button would
      // say "show me what I am already looking at".
      ...(q ? [[allResellerUsers]] : []),
      [cancel],
    ],
  );
}

/** Drop the search term and draw the whole list again. */
export const allResellerUsers: BotAction = {
  id: ACTIONS.resellerAllUsers,
  label: { key: BotKeys.action.resellerAllUsers },
};

/**
 * One customer (`F-311-c`), and what may be done to them.
 *
 * **`canWrite` decides the buttons and nothing else decides them.** It is the
 * door's second verdict (`GET /api/tenants/:id/access`, F-311-e), re-read for
 * this screen rather than carried from the menu: a suspended reseller still
 * reads its customers and no longer writes, and a seat revoked a minute ago
 * must stop blocking people. The routes refuse either way — this only keeps
 * the bot from offering a button whose answer is always no.
 *
 * A `banned` user gets no button at all: the platform banned that account, and
 * a reseller neither deepens nor lifts it (`user_banned`, 409).
 */
export function resellerUserView(
  user: { id: string; fullName: string; username: string; phoneMasked: string | null; status: string; createdAt: string },
  statusKey: string,
  joined: string,
  canWrite: boolean,
): BotView {
  const write: BotAction[][] =
    !canWrite || user.status === 'banned'
      ? []
      : user.status === 'suspended'
        ? [[{ id: `${RESELLER_UNBLOCK_PREFIX}${user.id}`, label: { key: BotKeys.action.resellerUnblock } }]]
        : [[{ id: `${RESELLER_BLOCK_PREFIX}${user.id}`, label: { key: BotKeys.action.resellerBlock } }]];

  return view(
    'reseller.user',
    {
      key: BotKeys.reseller.user,
      values: {
        name: user.fullName,
        username: user.username,
        phone: user.phoneMasked ?? '—',
        status: statusKey,
        joined,
      },
    },
    [...write, [cancel]],
  );
}

/**
 * "Really block them?" (`F-311-c`).
 *
 * Blocking signs that account out of everywhere it is, so it gets the same
 * confirmation removing an account does — and for the same reason: the tap
 * that causes it sits on the screen someone opened to *look* at a customer.
 * Unblocking has none; it gives access back.
 */
export function resellerBlockConfirmView(user: { id: string; fullName: string }): BotView {
  return view(
    'reseller.block.confirm',
    { key: BotKeys.reseller.blockAsk, values: { name: user.fullName } },
    [
      [{ id: `${RESELLER_BLOCK_PREFIX}${user.id}`, label: { key: BotKeys.action.resellerBlockYes } }],
      [cancel],
    ],
  );
}

/**
 * What the reseller earned (`F-311-c`, over F-311-b).
 *
 * Two figures, labelled, never added: `sales` is what its customers spent on
 * its services and `topUps` what they paid in, and ADR-0067 decision 1 is that
 * neither is the other. Both are billing's strings, rendered as they arrived —
 * the bot does no arithmetic on money (C-02) and none on the dates either.
 */
export function resellerRevenueView(totals: {
  from: string;
  to: string;
  sales: { total: string; count: number };
  topUps: { total: string; count: number };
}): BotView {
  return view(
    'reseller.revenue',
    {
      key: BotKeys.reseller.revenue,
      values: {
        from: totals.from,
        to: totals.to,
        sales: totals.sales.total,
        salesCount: String(totals.sales.count),
        topUps: totals.topUps.total,
        topUpsCount: String(totals.topUps.count),
      },
    },
    [[toMenu]],
  );
}
