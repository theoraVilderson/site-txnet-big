import { BotKey, BotKeys } from './bot-keys';

/**
 * Last-resort English for every key this bot can say.
 *
 * The copy that ships is in `locales/backend/langs/{fa,en}/bot.json`, served by
 * `locale-service`, and `F-317` will make it per-tenant. This table exists for
 * one failure only: a key that reached production before its translation did.
 * A user staring at a silent bot cannot log in, and a blank message is a worse
 * bug than an untranslated one.
 *
 * It lives here, next to the translator, and **never inside a flow** — a flow
 * that spells out a sentence is how per-tenant branding stops being possible
 * (`bot-app/contract.md`).
 *
 * Every value here is the English one, word for word. `bot-copy.spec.ts` holds
 * this table, `fa/bot.json` and `en/bot.json` to one key set and one set of
 * `{{placeholders}}`, because all three drifting apart is silent at runtime:
 * `BotCopy` renders the raw key and the bot keeps answering.
 */
export const BOT_COPY_FALLBACKS: Readonly<Record<string, string>> = {
  [BotKeys.menu.guest]: 'Hi 👋\nSign in to your account here, or create a new one.',
  [BotKeys.menu.member]: 'Welcome back 👋',
  [BotKeys.menu.restricted]: 'Your account is restricted: for now you can only talk to support.\nReason: {{reason}}',
  [BotKeys.menu.restrictedNoReason]: 'Your account is restricted: for now you can only talk to support.',
  [BotKeys.action.login]: 'Sign in',
  [BotKeys.action.register]: 'Create an account',
  [BotKeys.action.forgot]: 'I forgot my password',
  [BotKeys.action.logout]: 'Sign out',
  [BotKeys.action.cancel]: 'Cancel',
  [BotKeys.action.signOutAll]: 'Sign out of all accounts',
  [BotKeys.action.signOutAllYes]: 'Yes, sign out of all',
  [BotKeys.action.menu]: 'Main menu',
  [BotKeys.action.help]: 'Help',
  [BotKeys.action.language]: '🌐 Language / زبان',
  [BotKeys.action.back]: 'Back',
  [BotKeys.action.resend]: 'Send it again',
  [BotKeys.action.loginWithPassword]: 'Sign in with a password',
  [BotKeys.action.loginWithOtp]: 'Sign in with a code',
  [BotKeys.action.shareContact]: 'Send my number',
  [BotKeys.action.accounts]: 'My accounts',
  [BotKeys.action.miniApp]: '🚀 Open the app',
  [BotKeys.action.topUp]: '💳 Top up my wallet',
  [BotKeys.action.toPayment]: 'Continue to payment',
  [BotKeys.action.payNow]: 'Pay',
  [BotKeys.action.addAccount]: '➕ Add an account',
  [BotKeys.action.addWithOtp]: 'A code to its number',
  [BotKeys.action.addWithPassword]: 'Its password',
  [BotKeys.action.removeAccount]: '➖ Remove an account',
  [BotKeys.action.confirmRemove]: 'Yes, remove it',
  [BotKeys.accounts.signOutAllAsk]:
    'You will be signed out of every account in this chat. None is removed, and they stay reachable later without a new code. Sure?',
  [BotKeys.accounts.pick]:
    'You are signed in as {{name}}. Tap any other account to carry on as that one.',
  [BotKeys.accounts.none]:
    'You are signed in as {{name}}, and no other account is linked to it.\nAdd one below and you can move between them here with a single tap.',
  [BotKeys.accounts.member]: '{{name}} · {{phone}}',
  [BotKeys.accounts.memberNoPhone]: '{{name}}',
  [BotKeys.accounts.switched]: 'You are {{name}} now ✅',
  // Adding one (`F-0205`). The proof belongs to the account being added, so
  // every line says *that* account — a user who reads "your password" on the
  // second screen types the wrong one and is told, correctly but uselessly,
  // that it is wrong. What none of them do any more is explain why: the user
  // is answering a question, not being taught the security model.
  [BotKeys.accounts.addPickProof]: 'How should we add that account?',
  [BotKeys.accounts.addAskPhone]:
    "Send that account's number, with its country code if it is not from here. The code goes to that number, not to this chat.",
  [BotKeys.accounts.addAskIdentifier]: "Send that account's username or phone number.",
  [BotKeys.accounts.addAskPassword]:
    "Send that account's password. Your message is deleted right away.",
  // Since `F-0211` a successful add switches the chat onto the new account, so
  // this is the *refused-switch* wording, not the normal one: the add stands
  // and the accounts list is one tap away.
  [BotKeys.accounts.added]:
    'The account is added, but you are still signed in as before. Open “My accounts” to switch to it.',
  // Removing one (`F-0208`). Every line says *here*: the set belongs to this
  // chat (ADR-0015), so a user who also uses the website keeps whatever they
  // built there, and saying "removed" without saying where invites them to
  // think otherwise.
  [BotKeys.accounts.removePick]:
    'Which account should leave this chat? It is removed here only.',
  [BotKeys.accounts.removeSelf]: '{{name}} (the one you are using)',
  [BotKeys.accounts.removeConfirm]:
    "Remove {{name}} from this chat's accounts?\nYou can add it back whenever you like.",
  [BotKeys.accounts.removeConfirmSelf]:
    'Remove {{name}} — the one you are using right now?\nYou will be signed out of this chat, and the others stay where they are.',
  [BotKeys.accounts.removed]: "Removed from this chat's accounts ✅",
  [BotKeys.accounts.removedSelf]:
    'Removed, and you are signed out here. Sign in again whenever you like.',
  [BotKeys.accounts.removeFailed]:
    "That account is no longer one of this chat's accounts.",
  [BotKeys.common.cancelled]:
    'Cancelled; nothing was saved. Start again below whenever you like.',
  [BotKeys.common.unknown]: 'I did not catch that. Here is what I can do:',
  [BotKeys.common.expired]:
    'This conversation sat idle for a while, so I closed it; nothing was saved. Start again below.',
  [BotKeys.common.backGone]: 'There is nothing before this. You can start from here:',
  [BotKeys.common.pickOne]: 'Please pick one of the options above.',
  [BotKeys.common.tryAgain]: 'Something went wrong on our side. Please try again.',
  [BotKeys.common.signedIn]: 'You are signed in ✅',
  [BotKeys.common.signedOut]: 'You are signed out.',
  // ADR-0035: signing out of one account lands on the next one this place
  // already holds, rather than ending the place.
  [BotKeys.common.signedOutSwitched]:
    'Signed out of that account — you are now \u201c{{name}}\u201d.',
  [BotKeys.common.signedOutAll]:
    'Signed out of every account in this chat. None of them was removed.',
  [BotKeys.common.notSignedIn]: 'You are not signed in yet.',
  // ADR-0070: this chat's own bot ceiling refused it, and the Mini App is the
  // door that still works — it is a browser, so it can carry the slide a chat
  // cannot. The button under this sentence is why it is not the browser's own
  // “wait a while”. The sentence says "from this chat" and not "from this bot":
  // since the budget stopped being shared, it is this chat's own attempts that
  // ran out, and telling somebody the bot is busy would be wrong.
  [BotKeys.common.throttled]:
    'Too many sign-ins have been started from this chat just now, so you will need to wait a little. If you are in a hurry, open the app below and sign in there as usual.',
  [BotKeys.login.askPhone]:
    'Send your number with the button below, or type it yourself. A number from any country works — write it with its country code, like +49…',
  [BotKeys.login.askIdentifier]: 'Send your username or phone number.',
  // The fast path (ADR-0012). It asks for the card, not for a number, because
  // the card is the proof — there is no code after it.
  [BotKeys.login.askChatContact]:
    'Tap below to sign in with this account. No code, no password — sending your number is the proof.',
  [BotKeys.login.askPassword]:
    'Please send your password. Your message is deleted right away.',
  [BotKeys.login.askCode]: 'Send the 6-digit code.',
  [BotKeys.login.wrongCode]:
    'That code is not right. Send it again, or ask for a new one.',
  [BotKeys.login.pickChannel]: 'Where should I send the code?',
  [BotKeys.channel.sms]: 'SMS',
  [BotKeys.channel.telegram]: 'Telegram',
  [BotKeys.channel.bale]: 'Bale',
  [BotKeys.channel.none]:
    'There is no way to send the code right now. Please try again in a moment.',
  [BotKeys.channel.sent]: 'The code is on its way.',
  [BotKeys.link.required]:
    'Open {{platform}} with the button below and send your number there. Then come back and send me the code.',
  [BotKeys.link.open]: 'Open {{platform}}',
  [BotKeys.link.check]: 'I have done that',
  [BotKeys.link.waiting]:
    'I cannot see it yet. Finish up in {{platform}}, then tap this button again.',
  [BotKeys.register.askName]: 'What is your name?',
  [BotKeys.register.askUsername]: 'Pick a username.',
  [BotKeys.register.askPassword]:
    'Pick a password and send it. Your message is deleted right away.',
  [BotKeys.register.passwordKept]:
    'I could not delete your message — please delete it yourself.',
  [BotKeys.register.done]: 'Your account is ready and you are signed in ✅',
  [BotKeys.forgot.askPassword]:
    'Send your new password. Your message is deleted right away.',
  [BotKeys.forgot.done]:
    'Your password is changed and your other devices are signed out ✅',
  // Orientation. `{{n}}`/`{{total}}` come from `flows/steps.ts`; one key per
  // flow, because a sentence cannot be built by swapping a word into another.
  [BotKeys.progress.login]: 'Signing in · step {{n}} of {{total}}',
  [BotKeys.progress.register]: 'Creating your account · step {{n}} of {{total}}',
  [BotKeys.progress.forgot]: 'Resetting your password · step {{n}} of {{total}}',
  [BotKeys.progress.accountAdd]: 'Adding an account · step {{n}} of {{total}}',
  [BotKeys.progress.topUp]: 'Topping up · step {{n}} of {{total}}',
  [BotKeys.field.gateway]: 'Gateway: {{value}} ✅',
  [BotKeys.field.amount]: 'Amount: {{value}} ✅',
  // An amount and the currency it is in (F-116-h4): billing names the code, the
  // chat says its name. A code with no name here prints as the code (`money.ts`).
  [BotKeys.money.amount]: '{{amount}} {{currency}}',
  [BotKeys.money.list]: '{{first}}, {{rest}}',
  [BotKeys.money.currency.IRT]: 'Toman',
  [BotKeys.money.currency.IRR]: 'rials',
  [BotKeys.money.currency.USD]: 'USD',
  [BotKeys.topUp.pickGateway]: 'Which gateway would you like to pay with?',
  [BotKeys.topUp.none]: 'No payment gateway is available right now. Please try again a little later.',
  [BotKeys.topUp.askAmount]: 'How much would you like to add, in {{currency}}? Pick an amount or type one.',
  [BotKeys.topUp.quote]: 'Amount: {{amount}}\nFee: {{fee}}\nYou pay: {{payable}}\nAdded to your wallet: {{credited}}',
  [BotKeys.topUp.quoteTaxed]: 'Amount: {{amount}}\nFee: {{fee}}\nTax ({{taxRatePercent}}%): {{tax}}\nYou pay: {{payable}}\nAdded to your wallet: {{credited}}',
  [BotKeys.topUp.pay]:
    'Your payment is ready. Tap the button below to pay — once it is confirmed, you will get a message here.',
  [BotKeys.topUp.credited]: '{{credited}} was added to your wallet. Your balance is now {{balance}} ✅',
  [BotKeys.topUp.payInChat]: 'Your invoice is below. Pay it right here in the chat — you will get a message as soon as it is confirmed.',
  [BotKeys.topUp.invoiceTitle]: 'Wallet top-up',
  [BotKeys.topUp.invoiceDescription]: '{{credited}} added to your wallet',
  [BotKeys.topUp.invoiceLabel]: 'Top-up',
  [BotKeys.topUp.paidCredited]: '{{credited}} was added to your wallet ✅',
  [BotKeys.topUp.paidPending]: 'Your payment arrived and is being checked. You will get a message here once it is in your wallet.',
  [BotKeys.topUp.refusedNotFound]: 'This invoice is not yours or no longer exists. Start a new top-up from the menu.',
  [BotKeys.topUp.refusedNotPayable]: 'This invoice has expired or was already paid. Start a new top-up from the menu.',
  [BotKeys.topUp.refusedAmount]: 'This invoice no longer matches its payment. Start a new top-up from the menu.',
  // The reseller panel inside the bot (`F-311-c`). The two revenue figures are
  // labelled and never added: ADR-0067 decision 1, and `sales` is empty until
  // `entitlement` ships — a zero labelled "revenue" reads as a broken report.
  [BotKeys.action.reseller]: '🏪 Manage my reseller',
  [BotKeys.action.resellerUsers]: 'Customers',
  [BotKeys.action.resellerRevenue]: 'Sales report',
  [BotKeys.action.resellerBlock]: 'Block',
  [BotKeys.action.resellerBlockYes]: 'Yes, block them',
  [BotKeys.action.resellerUnblock]: 'Unblock',
  [BotKeys.action.resellerAllUsers]: 'All customers',
  [BotKeys.action.resellerNextPage]: 'Next page',
  [BotKeys.action.resellerPrevPage]: 'Previous page',
  [BotKeys.reseller.home]: 'Look after your reseller right here.',
  [BotKeys.reseller.usersPick]:
    '{{shown}} of {{total}} customers. Pick one, or type a name, username or number to search.',
  [BotKeys.reseller.usersEmpty]: 'Nobody has signed up on your reseller yet.',
  [BotKeys.reseller.usersNoMatch]: 'No customer matches “{{q}}”. Try something else, or see all of them.',
  [BotKeys.reseller.searchTooShort]: 'Type at least three characters to search.',
  [BotKeys.reseller.userRow]: '{{name}} · {{phone}}',
  [BotKeys.reseller.userRowNoPhone]: '{{name}}',
  [BotKeys.reseller.user]:
    '{{name}}\nUsername: {{username}}\nNumber: {{phone}}\nStatus: {{status}}\nJoined: {{joined}}',
  [BotKeys.reseller.statusActive]: 'Active',
  [BotKeys.reseller.statusSuspended]: 'Restricted (support only)',
  [BotKeys.reseller.statusBanned]: 'Banned',
  [BotKeys.reseller.blockAsk]:
    'Restrict {{name}}? They are signed out once; after that they can only talk to support.',
  [BotKeys.reseller.blocked]: '{{name}} is restricted ✅',
  [BotKeys.reseller.unblocked]: '{{name}} is active again ✅',
  [BotKeys.reseller.revenue]:
    '{{from}} to {{to}}\nService sales: {{sales}} ({{salesCount}})\nCustomer top-ups: {{topUps}} ({{topUpsCount}})',
  // The reseller's own bulk message (`F-313-b`). The segments are
  // compositions of `notification`'s audience filter, so each label names one
  // group and no screen offers a filter builder; the four status sentences are
  // whole sentences because a key interpolated into a value renders as itself.
  [BotKeys.progress.campaign]: 'Bulk message · step {{n}} of {{total}}',
  [BotKeys.action.resellerCampaigns]: '📣 Bulk message',
  [BotKeys.action.campaignRecent]: 'Recent broadcasts',
  [BotKeys.action.campaignSegAll]: 'All customers',
  [BotKeys.action.campaignSegActive]: 'Active customers only',
  [BotKeys.action.campaignSegNew]: 'Joined in the last 30 days',
  [BotKeys.action.campaignSend]: 'Yes, send it',
  [BotKeys.action.campaignRefresh]: 'Refresh',
  [BotKeys.action.timeZone]: '🕒 Time zone',
  [BotKeys.action.timeZoneFollowPanel]: '🖥 Same as the panel',
  [BotKeys.campaign.pickSegment]: 'Who should get this message?',
  [BotKeys.campaign.ask]: 'About {{count}} people will get it. Now write the message.',
  [BotKeys.campaign.empty]: 'Nobody is in that group right now. Pick another one.',
  [BotKeys.campaign.confirm]: 'This goes out to about {{count}} people:\n\n{{body}}\n\nShall I send it?',
  [BotKeys.campaign.statusDraft]: 'This message has not gone out yet.',
  [BotKeys.campaign.statusSending]: 'Sending… {{sent}} have it so far, {{failed}} did not go through.',
  [BotKeys.campaign.statusCompleted]: 'Sending finished ✅ {{sent}} got it, {{failed}} did not go through.',
  [BotKeys.campaign.statusStopped]: 'Sending was stopped. {{sent}} had it, {{failed}} did not go through.',
  [BotKeys.campaign.list]: 'Your recent broadcasts. Pick one to see where it is.',
  [BotKeys.campaign.listEmpty]: 'You have not sent a bulk message yet.',
  [BotKeys.campaign.row]: '{{date}} · {{preview}}',
  [BotKeys.campaign.readOnly]: 'You cannot start a new broadcast right now, but here is what you have sent.',
  [BotKeys.field.phone]: 'Number: {{value}} ✅',
  [BotKeys.field.identifier]: 'Account: {{value}} ✅',
  [BotKeys.field.name]: 'Name: {{value}} ✅',
  [BotKeys.field.username]: 'Username: {{value}} ✅',
  [BotKeys.field.channel.sms]: 'Code by SMS ✅',
  [BotKeys.field.channel.telegram]: 'Code by Telegram ✅',
  [BotKeys.field.channel.bale]: 'Code by Bale ✅',
  // The messenger's own command menu: one line each, and each one a verb.
  [BotKeys.command.start]: 'Start at the main menu',
  [BotKeys.command.menu]: 'Open the main menu',
  [BotKeys.command.cancel]: 'Drop what we are in the middle of',
  [BotKeys.command.logout]: 'Sign out of this chat',
  [BotKeys.command.help]: 'See what I can do',
  [BotKeys.command.lang]: 'Change the language',
  // The chooser labels each language in its own words, so these two lines are
  // the only ones a user who cannot read the current language has to get past.
  [BotKeys.language.pick]: 'Which language should I speak?',
  [BotKeys.language.changed]: '🌐 Language changed.',
  [BotKeys.language.only]: 'This bot speaks one language for now.',
  [BotKeys.timeZone.pick]: 'Your clock: {{zone}}\n{{from}}\nWhich time zone should your dates and quiet hours use?',
  [BotKeys.timeZone.chosen]: '🕒 Time zone set: {{zone}}.',
  [BotKeys.timeZone.followsPanel]: '🕒 I follow the panel now. Your clock: {{zone}}.',
  [BotKeys.timeZone.from.user]: 'You chose it.',
  [BotKeys.timeZone.from.browser]: 'Your panel set it.',
  [BotKeys.timeZone.from.tenant]: 'The service default.',
  [BotKeys.timeZone.from.platform]: 'The service default.',
  // F-038-g4: the answer to "don't show this again" under an AI suggestion.
  [BotKeys.suggestion.optedOut]: "🔕 Done. You won't get suggestions like this again.",
  [BotKeys.suggestion.gone]: 'This suggestion is no longer available.',
  // Help is not a manual. Back and Cancel are buttons on screen, and the two
  // commands below are the only ones worth naming in a message.
  [BotKeys.help.body]:
    'I look after your account right here in the chat: sign in, create an account, or change your password — without going anywhere else.\n\n' +
    '/menu — the main menu\n/logout — sign out of this chat',
  // F-707-h. The lucky wheel.
  [BotKeys.action.wheel]: '🎡 Lucky wheel',
  [BotKeys.action.wheelSpin]: '🎡 Spin',
  [BotKeys.wheel.screen]: '🎡 Lucky wheel\nThese are the real odds; our server picks the result.\n\n{{odds}}\n\n{{status}}',
  [BotKeys.wheel.canSpin]: 'Spins left today: {{n}}. Tap Spin!',
  [BotKeys.wheel.cannotSpin]: 'You cannot spin right now. {{reason}}',
  [BotKeys.wheel.none]: 'There is no wheel running today. Check back later.',
  [BotKeys.wheel.failed]: 'The wheel could not be reached. Tap Spin again — the same spin will not be counted twice.',
  [BotKeys.wheel.won.bonus_traffic_gb]: '🎉 You won {{value}} GB on your service.',
  [BotKeys.wheel.won.extra_days]: '🎉 You won {{value}} extra days on your service.',
  [BotKeys.wheel.won.discount_coupon]: '🎉 You won a {{value}}% discount coupon.\nYour code: {{code}}',
  [BotKeys.wheel.won.free_grant]: '🎉 You won a free service: {{label}}.',
  [BotKeys.wheel.won.empty]: 'No prize this time. Better luck next spin!',
  [BotKeys.wheel.refused]: 'No spin. {{reason}}',
  [BotKeys.wheel.refusals.account_inactive]: 'Your account is not active.',
  [BotKeys.wheel.refusals.account_too_new]: 'Your account is too new. Try again in a little while.',
  [BotKeys.wheel.refusals.phone_not_verified]: 'Verify your phone number first.',
  [BotKeys.wheel.refusals.no_active_service]: 'You need an active service to spin.',
  [BotKeys.wheel.refusals.paid_too_little]: 'The wheel is for customers who have bought a little more.',
  [BotKeys.wheel.refusals.too_few_orders]: 'The wheel is for customers with a few more paid orders.',
  [BotKeys.wheel.refusals.not_in_group]: 'This wheel is for a group of users you are not in.',
  [BotKeys.wheel.refusals.flagged]: 'Your account is under review, so it cannot spin.',
  [BotKeys.wheel.refusals.shared_device]: 'Too many accounts have used this chat, so it cannot spin.',
  [BotKeys.wheel.refusals.daily_limit]: 'You have used today\'s spins. Come back tomorrow.',
  [BotKeys.wheel.refusals.cooldown]: 'Wait a little before your next spin.',
  [BotKeys.wheel.refusals.no_wheel]: 'There is no wheel running today.',
  [BotKeys.wheel.refusals.no_fingerprint]: 'This chat could not be recognised. Open the menu and try again.',
  [BotKeys.wheel.refusals.spin_in_progress]: 'Your spin is already being processed. Tap Spin again in a moment.',
  // F-707-p. Lotteries in the chat.
  [BotKeys.action.lotteries]: "🎟 Lotteries",
  [BotKeys.action.lotteryJoin]: "✅ Join",
  [BotKeys.action.lotteryLeave]: "↩️ Leave",
  [BotKeys.action.lotteryResult]: "🏆 Result",
  [BotKeys.action.lotteriesBack]: "🎟 All lotteries",
  [BotKeys.lotteries.list]: "🎟 Your lotteries ({{n}}). Choose one to see its prizes and your entry.",
  [BotKeys.lotteries.none]: "There is no lottery for you right now.",
  [BotKeys.lotteries.item]: "{{title}} · {{status}}",
  [BotKeys.lotteries.card]: "🎟 {{title}}\n{{description}}\n{{status}}{{closes}}\n\n🎁 Prizes:\n{{prizes}}\n\n{{entry}}",
  [BotKeys.lotteries.status.open]: "Open",
  [BotKeys.lotteries.status.closing]: "Closing",
  [BotKeys.lotteries.status.frozen]: "Closed — drawing",
  [BotKeys.lotteries.status.drawn]: "Drawn",
  [BotKeys.lotteries.status.cancelled]: "Cancelled: {{reason}}",
  [BotKeys.lotteries.closesIn]: " — closes in {{left}}",
  [BotKeys.lotteries.left.days]: "{{d}} day(s) {{h}} hour(s)",
  [BotKeys.lotteries.left.hours]: "{{h}} hour(s) {{m}} min",
  [BotKeys.lotteries.left.minutes]: "{{m}} min",
  [BotKeys.lotteries.entry.automatic]: "Every eligible member of the group is entered at the close — nothing to do.",
  [BotKeys.lotteries.entry.canJoin]: "Entry is free. Tap Join to take part.",
  [BotKeys.lotteries.entry.joined]: "You are in. Your ticket number is given when the lottery closes.",
  [BotKeys.lotteries.entry.ticket]: "Your ticket: #{{n}}",
  [BotKeys.lotteries.entry.excluded]: "You were not entered. {{reason}}",
  [BotKeys.lotteries.excluded.not_in_group]: "You were no longer in the lottery's group at the close.",
  [BotKeys.lotteries.excluded.inactive]: "Your account was not active at the close.",
  [BotKeys.lotteries.excluded.account_too_new]: "Your account was too new at the close.",
  [BotKeys.lotteries.excluded.phone_unverified]: "Your phone number was not verified at the close.",
  [BotKeys.lotteries.excluded.flagged]: "Your account was under review at the close.",
  [BotKeys.lotteries.excluded.shared_device]: "Too many accounts have used your device.",
  [BotKeys.lotteries.refusals.lottery_not_found]: "This lottery is not available to you.",
  [BotKeys.lotteries.refusals.not_opt_in]: "This lottery enters its members automatically; there is nothing to join.",
  [BotKeys.lotteries.refusals.closed]: "This lottery is closed.",
  [BotKeys.lotteries.refusals.not_drawn]: "This lottery has not been drawn yet.",
  [BotKeys.lotteries.result]: "🏆 {{title}} — the result\n{{n}} ticket(s) in the draw.\n\n{{places}}\n\n✅ given · ↪️ passed on to a reserve · (n) took over place n\n\n{{mine}}\n\nAnyone can check this draw: the lottery's page in the panel redoes it from the published seed.",
  [BotKeys.lotteries.noPlaces]: "There were no tickets, so nobody was drawn.",
  [BotKeys.lotteries.mine.won]: "🎉 You won: {{prize}}",
  [BotKeys.lotteries.mine.lost]: "Your ticket #{{n}} did not win this time.",
  [BotKeys.action.support]: "💬 Support",
  [BotKeys.action.supportNew]: "✍️ New request",
  [BotKeys.action.supportRefresh]: "🔄 Refresh",
  [BotKeys.action.supportReopen]: "↩️ Reopen",
  [BotKeys.action.supportAll]: "💬 All conversations",
  [BotKeys.action.supportRate]: "{{n}} ⭐",
  [BotKeys.action.supportFile]: "📎 {{name}}",
  [BotKeys.support.list]: "💬 Your support conversations. Choose one, or start a new one.",
  [BotKeys.support.none]: "You have no support conversation yet. Start one and we will answer you right here.",
  [BotKeys.support.item]: "{{subject}} · {{status}}{{unread}}",
  [BotKeys.support.unread]: " · {{n}} new",
  [BotKeys.support.status.open]: "Waiting for an answer",
  [BotKeys.support.status.pending_agent]: "Waiting for an answer",
  [BotKeys.support.status.pending_user]: "Answered",
  [BotKeys.support.status.resolved]: "Resolved",
  [BotKeys.support.status.closed]: "Closed",
  [BotKeys.support.who.me]: "You",
  [BotKeys.support.who.agent]: "Support",
  [BotKeys.support.who.system]: "System",
  [BotKeys.support.who.bot]: "Bot",
  [BotKeys.support.who.ai]: "Assistant",
  [BotKeys.support.line]: "{{who}}: {{body}}",
  [BotKeys.support.file]: "📎 {{name}}",
  [BotKeys.support.thread]: "💬 {{subject}} · {{status}}\n\n{{earlier}}{{messages}}\n\n{{prompt}}",
  [BotKeys.support.earlier]: "… earlier messages are in the app.\n",
  [BotKeys.support.prompt.reply]: "Type your reply, or send a photo or a PDF.",
  [BotKeys.support.prompt.resolved]: "Marked resolved. If it is not, just reply and it opens again — or rate the answer.",
  [BotKeys.support.prompt.closed]: "This conversation is closed.",
  [BotKeys.support.category]: "What is it about?",
  [BotKeys.support.compose]: "Write your message. Once it is open you can send photos or PDFs too.",
  [BotKeys.support.composeFileFirst]: "Write your message first — you can send the file right after.",
  [BotKeys.support.fileOutside]: "To send a file to support, open a conversation first.",
  [BotKeys.support.fileUnreadable]: "That file could not be read. Send it again, or as a photo or a PDF.",
  [BotKeys.support.rated]: "Thank you for rating ⭐",
  [BotKeys.support.refusals.not_found]: "This conversation is not available.",
  [BotKeys.support.refusals.closed]: "This conversation is closed. Reopen it, or start a new one.",
  [BotKeys.support.refusals.category_unknown]: "That topic is no longer available. Start again.",
  [BotKeys.support.refusals.too_many_unfinished]: "You already have several open conversations. Finish one of them first.",
  [BotKeys.support.refusals.empty_message]: "The message is empty.",
  [BotKeys.support.refusals.too_many_files]: "Too many files in one message.",
  [BotKeys.support.refusals.file_too_large]: "That file is too large.",
  [BotKeys.support.refusals.file_rejected]: "Only photos (PNG, JPEG, WebP) and PDFs can be sent.",
  [BotKeys.support.refusals.file_infected]: "That file did not pass the virus check and was not sent.",
  [BotKeys.support.refusals.scan_unavailable]: "Files cannot be checked right now. Try again in a few minutes.",
  [BotKeys.support.refusals.quota_exceeded]: "Your space for support files is full.",
  [BotKeys.support.refusals.not_finished]: "You can rate it once it is resolved.",
  [BotKeys.support.refusals.already_rated]: "You have already rated this conversation.",
  [BotKeys.support.refusals.not_closed]: "This conversation is not closed.",
  [BotKeys.support.refusals.reopen_expired]: "It is too late to reopen this one. Start a new conversation.",
  [BotKeys.action.guides]: "📖 Guides",
  [BotKeys.action.guidesInstall]: "📲 How to connect",
  [BotKeys.guides.menu]: "📖 Guides. Choose one, or see how to connect on your device.",
  [BotKeys.guides.pickOs]: "Which device do you want to connect?",
  [BotKeys.guides.pickApp]: "Guides for {{os}}. Choose your app:",
  [BotKeys.guides.noneForOs]: "There is no guide for this system yet.",
  [BotKeys.guides.failed]: "Guides cannot be opened right now. Please try again in a moment.",
  [BotKeys.guides.gone]: "This guide is no longer available.",
  [BotKeys.guides.screen]: "📖 {{title}}\n\n{{text}}",
  [BotKeys.guides.os.android]: "Android",
  [BotKeys.guides.os.ios]: "iPhone / iPad",
  [BotKeys.guides.os.windows]: "Windows",
  [BotKeys.guides.os.macos]: "macOS",
  [BotKeys.guides.os.linux]: "Linux",
  [BotKeys.guides.feedback.yes]: "👍 Helpful",
  [BotKeys.guides.feedback.no]: "👎 Not helpful",
  [BotKeys.guides.feedback.thanks]: "Thanks, your answer is saved.",
  [BotKeys.guides.feedback.failed]: "Your answer was not saved. Please try again in a moment.",
  [BotKeys.support.suggested]: "These guides may already answer it. Open one — or send your message anyway, and support will answer here.",
  [BotKeys.action.supportSendAnyway]: "📨 Send it anyway",
} satisfies Record<BotKey, string>;
