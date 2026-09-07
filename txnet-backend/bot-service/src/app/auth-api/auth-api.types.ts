import { BotPlatform } from '@txnet-backend/messenger';

/**
 * The `auth-api` envelope. **`ok` is the only field that says whether the
 * request succeeded** — a business rejection (wrong password, duplicate user)
 * arrives with the route's own 200/201, so a client that branches on the
 * status code reads every rejection as a success
 * (`docs/interfaces/auth-api/contract.md`).
 */
export interface ApiResult<T> {
  ok: boolean;
  /** i18n key, already translated by auth-api into the request's language. */
  msg: string;
  data?: T;
  fieldErrors?: { path: string; message: string }[];
  /** Correlation id for a thrown (5xx/4xx) error's server-side log line. */
  ref?: string;
}

export type OtpChannelName = 'sms' | 'telegram' | 'bale';

export interface OtpChannelDescriptor {
  channel: OtpChannelName;
  requiresLink: boolean;
}

/** Answer to an OTP request: either the code went out, or a link must happen. */
export interface OtpRequestResult {
  accepted: true;
  linkRequired?: true;
  platform?: BotPlatform;
  linkToken?: string;
  deepLink?: string;
  expiresIn?: number;
}

export interface TokenPair {
  accessToken: string;
  expiresIn: number;
  /** Read out of the `refresh_token` cookie auth-api sets — see the client. */
  refreshToken?: string;
}

export interface PasswordLoginResult extends Partial<TokenPair> {
  requiresOtp?: true;
  otpToken?: string;
}

/**
 * Signing in as the messenger account itself (ADR-0012). `needsContact` is the
 * only branch that asks the user for anything, and it asks once.
 */
export interface BotSessionResult {
  state: 'authenticated' | 'needsContact';
  tokens?: { accessToken: string; refreshToken: string; expiresIn: number };
}

export interface BotLinkOutcome {
  state: 'pending' | 'linked' | 'failed';
  needsContact: boolean;
  otpSent: boolean;
  messageKey: string;
  failureKey?: string;
  lang: string;
}

export interface BotLinkStatus {
  state: 'pending' | 'linked' | 'failed';
  otpSent: boolean;
  failureKey?: string;
}

/**
 * One account the caller may become (`F-0206`). The phone arrives already
 * masked — the list exists so a user can tell their own accounts apart, and
 * four digits does that (`audit` invariant #6).
 */
export interface SwitchGroupMember {
  userId: string;
  fullName: string;
  phoneMasked: string | null;
}

/** The caller's switch group. No group yet is `groupId: null`, not an error. */
export interface SwitchGroup {
  groupId: string | null;
  current: SwitchGroupMember;
  members: SwitchGroupMember[];
}

/**
 * The answer to a switch (`F-0207`): the target's own token pair, exactly as a
 * login returns one. The caller's session is already revoked by the time this
 * arrives, so there is nothing left to fall back to.
 */
export interface SwitchResult extends TokenPair {
  userId: string;
  fullName: string;
}

/**
 * The answer to a join (`F-0205`). `added: false` is still a success: the
 * account was already in this group, so the proof bought nothing but the end
 * state is the one that was asked for.
 *
 * `userId` is the account that joined — the only name for it the caller has,
 * since what was typed was a phone number or a username and only the proof
 * resolved that to an account. Both success branches carry it, which is what
 * lets the chat land on the account it has just added rather than telling the
 * user to go and find it.
 */
export interface AddAccountResult {
  groupId: string;
  added: boolean;
  userId: string;
}

/**
 * The answer to a removal (`F-0208`). Nothing is minted and no session comes
 * back, even when the account removed itself: leaving a group is a sign-out on
 * this surface, not a handover to another account.
 */
export interface RemoveAccountResult {
  userId: string;
  removed: boolean;
}
