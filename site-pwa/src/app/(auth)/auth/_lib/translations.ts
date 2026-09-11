import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { BackendErrorKeysKey } from "@/generated/i18n-keys.errors";
import { BackendErrorKeys } from "@/generated/i18n-keys.errors";

/** The `auth` namespace, as generated constants (F-082, ADR-0036). */
const A = FrontendI18nKeys.auth;

/**
 * The auth namespace is authored NESTED in
 * `locales/frontend/langs/<lang>/auth.json` (login.title, fields.phone, …), but
 * the components read short flat names (`t.loginTitle`, `t.usernameTab`, …).
 *
 * This map is the single source of truth linking the two: flat component key →
 * dot path inside the (flattened) auth namespace. `AuthUIProvider` resolves
 * `t.<flatKey>` through it. Add a row here when a component needs a new string.
 *
 * **The values are generated constants, not strings** (F-082). This map used to
 * be `satisfies Record<string, string>` — sixty unchecked dot paths — and no
 * test anywhere read `locales/frontend`, so a key renamed in `auth.json`
 * rendered as the raw path on the login screen with every suite green. A
 * renamed key is now a compile error on the row that cites it.
 */
export const AUTH_KEY_MAP = {
  loginTitle: A.login.title,
  welcomeSubtitle: A.login.subtitle,
  noAccount: A.login.prompt,
  login: A.login.action,
  backTo: A.login.backTo,
  loginPage: A.login.pageLink,
  usernameTab: A.login.tabs.username,
  phoneTab: A.login.tabs.phone,

  registerTitle: A.register.title,
  alreadyRegistered: A.register.prompt,
  register: A.register.action,

  forgotTitle: A.forgotPassword.title,
  forgotSubtitle: A.forgotPassword.subtitle,
  forgotPassword: A.forgotPassword.prompt,
  sendRecoveryLink: A.forgotPassword.action,

  resetTitle: A.resetPassword.title,
  resetSubtitle: A.resetPassword.subtitle,
  saveNewPassword: A.resetPassword.action,

  fullName: A.fields.fullName,
  username: A.fields.username,
  phone: A.fields.phone,
  country: A.fields.country,
  countrySearch: A.fields.countrySearch,
  countryNoResults: A.fields.countryNoResults,
  password: A.fields.password,
  newPassword: A.fields.newPassword,
  confirmPassword: A.fields.confirmPassword,

  loginToDashboard: A.buttons.loginToDashboard,
  getVerifyCode: A.buttons.getVerifyCode,
  verifyAndLogin: A.buttons.verifyAndLogin,
  verifyAndContinue: A.buttons.verifyAndContinue,
  showPassword: A.buttons.showPassword,
  hidePassword: A.buttons.hidePassword,
  resendCode: A.buttons.resendCode,
  editPhone: A.buttons.editPhone,

  codeSentTo: A.messages.codeSentTo,
  yourNumber: A.messages.yourNumber,
  processing: A.messages.processing,
  resendCodeIn: A.messages.resendCodeIn,
  seconds: A.messages.seconds,
  redirecting: A.messages.redirecting,
  loginSuccess: A.messages.success.login,
  registerSuccess: A.messages.success.register,
  resetSuccess: A.messages.success.reset,
  passwordMismatch: A.messages.errors.passwordMismatch,

  captchaVerified: A.captcha.verified,
  captchaSwipe: A.captcha.swipe,
  captchaChecking: A.captcha.checking,

  otpChannelLabel: A.otpChannel.label,
  otpChannelSms: A.otpChannel.sms,
  otpChannelTelegram: A.otpChannel.telegram,
  otpChannelBale: A.otpChannel.bale,

  otpDeliverySending: A.otpDelivery.sending,
  otpDeliverySent: A.otpDelivery.sent,
  otpDeliveryFailed: A.otpDelivery.failed,
  otpDeliverySmsNotConfigured: A.otpDelivery.smsNotConfigured,
  otpDeliveryUnavailable: A.otpDelivery.unavailable,

  botLinkSubtitle: A.botLink.subtitle,
  botLinkOpen: A.botLink.open,
  botLinkWaiting: A.botLink.waiting,
  botLinkFailed: A.botLink.failed,
  botLinkChangeMethod: A.botLink.changeMethod,
} as const;

export type Lang = string;

/** `{ loginTitle: string; usernameTab: string; ... }` — the shape components see. */
export type AuthTranslations = Record<keyof typeof AUTH_KEY_MAP, string>;

/**
 * A refused OTP send arrives as a **backend** `errors` key, off a socket that
 * does not pass through `locale-service`, so the screen owns the sentence — this
 * maps each one onto the component string that says it (F-082).
 *
 * It crosses a scope boundary on purpose, and both sides are now typed: the
 * left is `BackendErrorKeys` (the backend `errors` namespace, generated for
 * this app because it cannot import `shared-core`), the right is a key of this
 * map. It lived as a bare literal table inside `OtpStep.tsx`, two vocabularies
 * in one object with nothing checking either. A key with no row is still a
 * failed send and falls back to the general line rather than to nothing.
 */
const OTP = BackendErrorKeys.errors.otp;
export const OTP_FAILURE_STRINGS: Partial<
  Record<BackendErrorKeysKey<"errors">, keyof AuthTranslations>
> = {
  [OTP.smsNotConfigured]: "otpDeliverySmsNotConfigured",
  [OTP.deliveryUnavailable]: "otpDeliveryUnavailable",
  [OTP.deliveryFailed]: "otpDeliveryFailed",
};

/**
 * The component string for a failure key that came off the wire.
 *
 * Takes a plain `string` because that is what a socket delivers — the wire is
 * not typed, only this table is. An unknown key is still a failed send, so it
 * answers the general line; `hasOwn` keeps a key like `constructor` from
 * resolving to something on the prototype.
 */
export function otpFailureString(key: string | null | undefined): keyof AuthTranslations {
  const table = OTP_FAILURE_STRINGS as Record<string, keyof AuthTranslations | undefined>;
  return (key && Object.hasOwn(table, key) && table[key]) || "otpDeliveryFailed";
}
