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
export const BOT_COPY_FALLBACKS: Record<string, string> = {
  'bot.menu.guest': 'Hi 👋\nSign in to your account here, or create a new one.',
  'bot.menu.member': 'Welcome back 👋',
  'bot.action.login': 'Sign in',
  'bot.action.register': 'Create an account',
  'bot.action.forgot': 'I forgot my password',
  'bot.action.logout': 'Sign out',
  'bot.action.cancel': 'Cancel',
  'bot.action.menu': 'Main menu',
  'bot.action.help': 'Help',
  'bot.action.language': '🌐 Language / زبان',
  'bot.action.back': 'Back',
  'bot.action.resend': 'Send it again',
  'bot.action.loginWithPassword': 'Sign in with a password',
  'bot.action.loginWithOtp': 'Sign in with a code',
  'bot.action.shareContact': 'Send my number',
  'bot.action.accounts': 'My accounts',
  'bot.action.miniApp': '🚀 Open the app',
  'bot.action.addAccount': '➕ Add an account',
  'bot.action.addWithOtp': 'A code to its number',
  'bot.action.addWithPassword': 'Its password',
  'bot.action.removeAccount': '➖ Remove an account',
  'bot.action.confirmRemove': 'Yes, remove it',
  'bot.accounts.pick':
    'You are signed in as {{name}}. Tap any other account to carry on as that one.',
  'bot.accounts.none':
    'You are signed in as {{name}}, and no other account is linked to it.\nAdd one below and you can move between them here with a single tap.',
  'bot.accounts.member': '{{name}} · {{phone}}',
  'bot.accounts.memberNoPhone': '{{name}}',
  'bot.accounts.switched': 'You are {{name}} now ✅',
  // Adding one (`F-0205`). The proof belongs to the account being added, so
  // every line says *that* account — a user who reads "your password" on the
  // second screen types the wrong one and is told, correctly but uselessly,
  // that it is wrong. What none of them do any more is explain why: the user
  // is answering a question, not being taught the security model.
  'bot.accounts.addPickProof': 'How should we add that account?',
  'bot.accounts.addAskPhone':
    "Send that account's number, with its country code if it is not from here. The code goes to that number, not to this chat.",
  'bot.accounts.addAskIdentifier': "Send that account's username or phone number.",
  'bot.accounts.addAskPassword':
    "Send that account's password. Your message is deleted right away.",
  // Since `F-0211` a successful add switches the chat onto the new account, so
  // this is the *refused-switch* wording, not the normal one: the add stands
  // and the accounts list is one tap away.
  'bot.accounts.added':
    'The account is added, but you are still signed in as before. Open “My accounts” to switch to it.',
  // Removing one (`F-0208`). Every line says *here*: the set belongs to this
  // chat (ADR-0015), so a user who also uses the website keeps whatever they
  // built there, and saying "removed" without saying where invites them to
  // think otherwise.
  'bot.accounts.removePick':
    'Which account should leave this chat? It is removed here only.',
  'bot.accounts.removeSelf': '{{name}} (the one you are using)',
  'bot.accounts.removeConfirm':
    "Remove {{name}} from this chat's accounts?\nYou can add it back whenever you like.",
  'bot.accounts.removeConfirmSelf':
    'Remove {{name}} — the one you are using right now?\nYou will be signed out of this chat, and the others stay where they are.',
  'bot.accounts.removed': "Removed from this chat's accounts ✅",
  'bot.accounts.removedSelf':
    'Removed, and you are signed out here. Sign in again whenever you like.',
  'bot.accounts.removeFailed':
    "That account is no longer one of this chat's accounts.",
  'bot.common.cancelled':
    'Cancelled; nothing was saved. Start again below whenever you like.',
  'bot.common.unknown': 'I did not catch that. Here is what I can do:',
  'bot.common.expired':
    'This conversation sat idle for a while, so I closed it; nothing was saved. Start again below.',
  'bot.common.backGone': 'There is nothing before this. You can start from here:',
  'bot.common.pickOne': 'Please pick one of the options above.',
  'bot.common.tryAgain': 'Something went wrong on our side. Please try again.',
  'bot.common.signedIn': 'You are signed in ✅',
  'bot.common.signedOut': 'You are signed out.',
  'bot.common.notSignedIn': 'You are not signed in yet.',
  'bot.login.askPhone':
    'Send your number with the button below, or type it yourself. A number from any country works — write it with its country code, like +49…',
  'bot.login.askIdentifier': 'Send your username or phone number.',
  // The fast path (ADR-0012). It asks for the card, not for a number, because
  // the card is the proof — there is no code after it.
  'bot.login.askChatContact':
    'Tap below to sign in with this account. No code, no password — sending your number is the proof.',
  'bot.login.askPassword':
    'Please send your password. Your message is deleted right away.',
  'bot.login.askCode': 'Send the 6-digit code.',
  'bot.login.wrongCode':
    'That code is not right. Send it again, or ask for a new one.',
  'bot.login.pickChannel': 'Where should I send the code?',
  'bot.channel.sms': 'SMS',
  'bot.channel.telegram': 'Telegram',
  'bot.channel.bale': 'Bale',
  'bot.channel.none':
    'There is no way to send the code right now. Please try again in a moment.',
  'bot.channel.sent': 'The code is on its way.',
  'bot.link.required':
    'Open {{platform}} with the button below and send your number there. Then come back and send me the code.',
  'bot.link.open': 'Open {{platform}}',
  'bot.link.check': 'I have done that',
  'bot.link.waiting':
    'I cannot see it yet. Finish up in {{platform}}, then tap this button again.',
  'bot.register.askName': 'What is your name?',
  'bot.register.askUsername': 'Pick a username.',
  'bot.register.askPassword':
    'Pick a password and send it. Your message is deleted right away.',
  'bot.register.passwordKept':
    'I could not delete your message — please delete it yourself.',
  'bot.register.done': 'Your account is ready and you are signed in ✅',
  'bot.forgot.askPassword':
    'Send your new password. Your message is deleted right away.',
  'bot.forgot.done':
    'Your password is changed and your other devices are signed out ✅',
  // Orientation. `{{n}}`/`{{total}}` come from `flows/steps.ts`; one key per
  // flow, because a sentence cannot be built by swapping a word into another.
  'bot.progress.login': 'Signing in · step {{n}} of {{total}}',
  'bot.progress.register': 'Creating your account · step {{n}} of {{total}}',
  'bot.progress.forgot': 'Resetting your password · step {{n}} of {{total}}',
  'bot.progress.accountAdd': 'Adding an account · step {{n}} of {{total}}',
  'bot.field.phone': 'Number: {{value}} ✅',
  'bot.field.identifier': 'Account: {{value}} ✅',
  'bot.field.name': 'Name: {{value}} ✅',
  'bot.field.username': 'Username: {{value}} ✅',
  'bot.field.channel.sms': 'Code by SMS ✅',
  'bot.field.channel.telegram': 'Code by Telegram ✅',
  'bot.field.channel.bale': 'Code by Bale ✅',
  // The messenger's own command menu: one line each, and each one a verb.
  'bot.command.start': 'Start at the main menu',
  'bot.command.menu': 'Open the main menu',
  'bot.command.cancel': 'Drop what we are in the middle of',
  'bot.command.logout': 'Sign out of this chat',
  'bot.command.help': 'See what I can do',
  'bot.command.lang': 'Change the language',
  // The chooser labels each language in its own words, so these two lines are
  // the only ones a user who cannot read the current language has to get past.
  'bot.language.pick': 'Which language should I speak?',
  'bot.language.changed': '🌐 Language changed.',
  'bot.language.only': 'This bot speaks one language for now.',
  // Help is not a manual. Back and Cancel are buttons on screen, and the two
  // commands below are the only ones worth naming in a message.
  'bot.help.body':
    'I look after your account right here in the chat: sign in, create an account, or change your password — without going anywhere else.\n\n' +
    '/menu — the main menu\n/logout — sign out of this chat',
};
