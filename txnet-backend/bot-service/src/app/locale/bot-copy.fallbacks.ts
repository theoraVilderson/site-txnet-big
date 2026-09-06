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
 */
export const BOT_COPY_FALLBACKS: Record<string, string> = {
  'bot.menu.guest': 'Welcome. Sign in, or create an account.',
  'bot.menu.member': 'You are signed in.',
  'bot.action.login': 'Sign in',
  'bot.action.register': 'Create an account',
  'bot.action.forgot': 'I forgot my password',
  'bot.action.logout': 'Sign out',
  'bot.action.cancel': 'Cancel',
  'bot.action.menu': 'Main menu',
  'bot.action.help': 'What can you do?',
  'bot.action.language': '🌐 Language',
  'bot.action.back': 'Back',
  'bot.action.resend': 'Send the code again',
  'bot.action.loginWithPassword': 'Sign in with a password',
  'bot.action.loginWithOtp': 'Sign in with a one-time code',
  'bot.action.shareContact': 'Share my number',
  'bot.action.accounts': 'My accounts',
  'bot.action.addAccount': '➕ Add an account',
  'bot.action.addWithOtp': "A code to that account's number",
  'bot.action.addWithPassword': "That account's password",
  'bot.action.removeAccount': '➖ Remove an account',
  'bot.action.confirmRemove': 'Yes, remove it',
  'bot.accounts.pick':
    'You are signed in as {{name}}. Tap another account to become it — no password, no code.',
  'bot.accounts.none':
    'You are signed in as {{name}}, and no other account is linked to it yet. Add one below: that account proves itself once — a code to its own number, or its own password — and after that you can move between them here with one tap.',
  'bot.accounts.member': '{{name}} · {{phone}}',
  'bot.accounts.memberNoPhone': '{{name}}',
  'bot.accounts.switched': 'You are now {{name}}.',
  // Adding one (`F-0205`). The proof belongs to the account being added, and
  // every line here says so — a user who reads "your password" on the second
  // screen types the wrong one and is told, correctly but uselessly, that it
  // is wrong.
  'bot.accounts.addPickProof':
    'The account you are adding has to prove it is yours. How should it do that?',
  'bot.accounts.addAskPhone':
    'Send the phone number of the account you are adding (09xxxxxxxxx). The code goes to that number, not to this chat.',
  'bot.accounts.addAskIdentifier':
    'Send the username or phone number of the account you are adding.',
  'bot.accounts.addAskPassword':
    "Send that account's password. It is deleted from this chat the moment it arrives.",
  'bot.accounts.added':
    '✅ The account is added. You are still signed in as before — open “My accounts” whenever you want to switch to it.',
  // Removing one (`F-0208`). Every line says *here*: the set belongs to this
  // chat (ADR-0015), so a user who also uses the website keeps whatever they
  // built there, and saying "removed" without saying where invites them to
  // think otherwise.
  'bot.accounts.removePick':
    'Which account should leave this set? It is removed here only — anything you set up on the website stays as it is.',
  'bot.accounts.removeSelf': '{{name}} (this one — sign me out here)',
  'bot.accounts.removeConfirm':
    'Remove {{name}} from your accounts in this chat? It will be signed out here, and you can add it back any time by proving it again.',
  'bot.accounts.removeConfirmSelf':
    'Remove {{name}} — the account you are using right now? You will be signed out of this chat, and the others stay where they are.',
  'bot.accounts.removed':
    '✅ Removed from your accounts in this chat.',
  'bot.accounts.removedSelf':
    '✅ Removed, and you are signed out here. Tap Sign in whenever you want to come back.',
  'bot.accounts.removeFailed':
    'That account is no longer one you can remove here.',
  'bot.common.cancelled': 'Cancelled — nothing was saved. Pick something below whenever you are ready.',
  'bot.common.unknown': 'I did not understand that. Here is everything I can do:',
  'bot.common.expired':
    'That conversation has been idle too long, so I have let it go — nothing was saved. Start again below; it takes a moment.',
  'bot.common.backGone':
    'There is nothing before this. Here is where you can start from:',
  'bot.common.pickOne': 'Please choose one of the options above.',
  'bot.common.tryAgain': 'Something went wrong on our side. Please try again.',
  'bot.common.signedIn': '✅ You are signed in.',
  'bot.common.signedOut': 'You are signed out.',
  'bot.common.notSignedIn': 'You are not signed in.',
  'bot.login.askPhone':
    'Share your number with the button below, or type it (09xxxxxxxxx).',
  'bot.login.askIdentifier': 'Send your username or phone number.',
  // The fast path (ADR-0012). It asks for the card, not for a number, because
  // the card is the proof — there is no code after it.
  'bot.login.askChatContact':
    'Tap below to sign in with this Telegram account. No code, no password — sharing your number is the proof.',
  'bot.login.askPassword':
    'Send your password. It is deleted from this chat the moment it arrives.',
  'bot.login.askCode': 'Send the 6-digit code.',
  'bot.login.wrongCode': 'That code is not right. Try again, or ask for a new one.',
  'bot.login.pickChannel': 'Where should the code go?',
  'bot.channel.sms': 'SMS',
  'bot.channel.telegram': 'Telegram',
  'bot.channel.bale': 'Bale',
  'bot.channel.none':
    'No delivery method is available right now. Please try again later.',
  'bot.channel.sent': 'The code is on its way.',
  'bot.link.required':
    'Open {{platform}} with the button below and share your number there. Then come back and send me the code.',
  'bot.link.open': 'Open {{platform}}',
  'bot.link.check': 'I have done that',
  'bot.link.waiting':
    'I cannot see it yet. Finish in {{platform}}, then press the button again.',
  'bot.register.askName': 'What is your full name?',
  'bot.register.askUsername': 'Choose a username.',
  'bot.register.askPassword':
    'Choose a password. It is deleted from this chat the moment it arrives.',
  'bot.register.passwordKept':
    'I could not delete your message — please delete it yourself.',
  'bot.register.done': '✅ Your account is ready and you are signed in.',
  'bot.forgot.askPassword':
    'Send your new password. It is deleted from this chat the moment it arrives.',
  'bot.forgot.done':
    '✅ Your password is changed and every other device has been signed out.',
  // Orientation. `{{n}}`/`{{total}}` come from `flows/steps.ts`; one key per
  // flow, because a sentence cannot be built by swapping a word into another.
  'bot.progress.login': 'Signing in · step {{n}} of {{total}}',
  'bot.progress.register': 'Creating your account · step {{n}} of {{total}}',
  'bot.progress.forgot': 'Resetting your password · step {{n}} of {{total}}',
  'bot.progress.accountAdd': 'Adding an account · step {{n}} of {{total}}',
  'bot.field.phone': '✅ Number: {{value}}',
  'bot.field.identifier': '✅ Account: {{value}}',
  'bot.field.name': '✅ Name: {{value}}',
  'bot.field.username': '✅ Username: {{value}}',
  'bot.field.channel.sms': '✅ Code by: SMS',
  'bot.field.channel.telegram': '✅ Code by: Telegram',
  'bot.field.channel.bale': '✅ Code by: Bale',
  'bot.command.start': 'Start over at the main menu',
  'bot.command.menu': 'The main menu',
  'bot.command.cancel': 'Drop what we are in the middle of',
  'bot.command.logout': 'Sign out of this chat',
  'bot.command.help': 'What this bot can do',
  'bot.command.lang': 'Change the language',
  // The chooser labels each language in its own words, so these two lines are
  // the only ones a user who cannot read the current language has to get past.
  'bot.language.pick': 'Which language should I speak?',
  'bot.language.changed': '🌐 Language changed.',
  'bot.language.only': 'This bot speaks one language at the moment.',
  'bot.help.body':
    'I am your account here in this chat: sign in, create an account, or reset a password — all of it without leaving the conversation.\n\n' +
    '/menu — the main menu\n/cancel — drop whatever we are in the middle of\n/logout — sign out of this chat\n/help — this message\n\n' +
    'While we are talking you can always go Back one question or Cancel. Nothing is saved until the last step, and a password you type is deleted from the chat the moment it is used.',
};
