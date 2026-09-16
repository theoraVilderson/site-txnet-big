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
  [BotKeys.topUp.pickGateway]: 'Which gateway would you like to pay with?',
  [BotKeys.topUp.none]: 'No payment gateway is available right now. Please try again a little later.',
  [BotKeys.topUp.askAmount]: 'How much would you like to add? Pick an amount or type one.',
  [BotKeys.topUp.quote]: 'Amount: {{amount}}\nFee: {{fee}}\nYou pay: {{payable}}\nAdded to your wallet: {{credited}}',
  [BotKeys.topUp.pay]:
    'Your payment is ready. Tap the button below to pay — once it is confirmed, you will get a message here.',
  [BotKeys.topUp.credited]: '{{credited}} was added to your wallet. Your balance is now {{balance}} ✅',
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
  // Help is not a manual. Back and Cancel are buttons on screen, and the two
  // commands below are the only ones worth naming in a message.
  [BotKeys.help.body]:
    'I look after your account right here in the chat: sign in, create an account, or change your password — without going anywhere else.\n\n' +
    '/menu — the main menu\n/logout — sign out of this chat',
} satisfies Record<BotKey, string>;
