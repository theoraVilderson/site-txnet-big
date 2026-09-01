/**
 * The auth namespace is authored NESTED in
 * `locales/frontend/langs/<lang>/auth.json` (login.title, fields.phone, …), but
 * the components read short flat names (`t.loginTitle`, `t.usernameTab`, …).
 *
 * This map is the single source of truth linking the two: flat component key →
 * dot path inside the (flattened) auth namespace. `AuthUIProvider` resolves
 * `t.<flatKey>` through it. Add a row here when a component needs a new string.
 */
export const AUTH_KEY_MAP = {
  loginTitle: "login.title",
  welcomeSubtitle: "login.subtitle",
  noAccount: "login.prompt",
  login: "login.action",
  backTo: "login.backTo",
  loginPage: "login.pageLink",
  usernameTab: "login.tabs.username",
  phoneTab: "login.tabs.phone",

  signupTitle: "signup.title",
  alreadyRegistered: "signup.prompt",
  signup: "signup.action",

  forgotTitle: "forgotPassword.title",
  forgotSubtitle: "forgotPassword.subtitle",
  forgotPassword: "forgotPassword.prompt",
  sendRecoveryLink: "forgotPassword.action",

  resetTitle: "resetPassword.title",
  resetSubtitle: "resetPassword.subtitle",
  saveNewPassword: "resetPassword.action",

  fullName: "fields.fullName",
  username: "fields.username",
  phone: "fields.phone",
  password: "fields.password",
  newPassword: "fields.newPassword",
  confirmPassword: "fields.confirmPassword",

  loginToDashboard: "buttons.loginToDashboard",
  getVerifyCode: "buttons.getVerifyCode",
  verifyAndLogin: "buttons.verifyAndLogin",
  verifyAndContinue: "buttons.verifyAndContinue",
  showPassword: "buttons.showPassword",
  hidePassword: "buttons.hidePassword",
  resendCode: "buttons.resendCode",
  editPhone: "buttons.editPhone",

  codeSentTo: "messages.codeSentTo",
  yourNumber: "messages.yourNumber",
  processing: "messages.processing",
  resendCodeIn: "messages.resendCodeIn",
  seconds: "messages.seconds",
  redirecting: "messages.redirecting",
  loginSuccess: "messages.success.login",
  signupSuccess: "messages.success.signup",
  resetSuccess: "messages.success.reset",
  passwordMismatch: "messages.errors.passwordMismatch",

  captchaVerified: "captcha.verified",
  captchaSwipe: "captcha.swipe",
} as const satisfies Record<string, string>;

export type Lang = string;

/** `{ loginTitle: string; usernameTab: string; ... }` — the shape components see. */
export type AuthTranslations = Record<keyof typeof AUTH_KEY_MAP, string>;
