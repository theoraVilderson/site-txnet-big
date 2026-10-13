// The caller's own account: who they are, their settings and sessions, the accounts they switch between (F-097, F-0205..8).
import type { UiPreferences, UiPreferencesPatch } from "@/stores/ui-preferences-store";
import type { ResolvedTimeZone, TimeZoneSource } from "../time-zone";
import type { TenantType } from "../tenant-type";
import { request, setAccessToken } from "./credential";
import type { AuthResult, OtpChannel, OtpQueued, OtpRequestResult } from "./sign-in";

/**
 * One account in the caller's switch group (F-0206). The phone arrives already
 * masked — the server never sends the full number to this page, because the
 * switcher is rendered wherever the user happens to be sitting.
 */
export type SwitchAccount = {
  userId: string;
  fullName: string;
  phoneMasked: string | null;
};

export type SwitchGroup = {
  groupId: string | null;
  current: SwitchAccount;
  members: SwitchAccount[];
};

/**
 * Who this caller is and what it may do (F-097).
 *
 * `permissions` is the list the access token carries, which is the same list
 * `forward-auth` gates every request on — so a surface that hides an entry the
 * caller does not hold is hiding exactly what the edge would refuse. `tenant.type`
 * is the second door an operator surface needs: `settlement.manage` on a
 * reseller's own role does not make that reseller the platform owner.
 */
/**
 * One reseller the caller owns (`GET /auth/handoff`, F-061-f). `here`: this
 * request came through its own panel domain (F-061-m). `hasPanel`: a handoff
 * to it would land — it has a verified panel domain (F-061-n). `live`: not
 * terminated — an owner holds one at a time (`already_reseller`).
 */
export type OwnedReseller = { id: string; slug: string; here: boolean; hasPanel: boolean; live: boolean };

export type Me = {
  userId: string;
  fullName: string;
  role: { id: string; name: string };
  permissions: string[];
  /** `isOwner`: the caller is the tenant's owner (F-019-f). */
  tenant: { id: string; type: TenantType; isOwner: boolean };
  /** Always verified when present: only *confirm email* writes it (F-035-g). */
  email: string | null;
  isImpersonated: boolean;
  impersonatedBy?: string;
  /** Set while the account is restricted to support (ADR-0133), with the reason staff wrote. */
  restriction?: { reason: string | null } | null;
};

/**
 * One user as `GET /auth/users` answers (F-018-ad): enough to tell two people
 * apart and to see one is suspended — never the number, never an email.
 */
/** `identity.user.status` (ADR-0133): `suspended` is restricted to support, `banned` is out. */
export type AccountStatus = "active" | "suspended" | "banned";

export type UserStatusView = { id: string; status: AccountStatus; statusReason: string | null };

export type UserSearchHit = {
  id: string;
  fullName: string;
  username: string | null;
  phoneMasked: string | null;
  status: "active" | "suspended" | "banned";
};

/** The messengers a user may take notices on (F-601-u); `both` is also what an unchosen one reads as. */
export const NOTICE_MESSENGERS = ["both", "telegram", "bale"] as const;

export type NoticeMessenger = (typeof NOTICE_MESSENGERS)[number];

/** `linked`: the platforms with a verified chat, so the panel can say which one is not linked yet. */
export type MeMessenger = { messenger: NoticeMessenger; chosen: boolean; linked: Array<"telegram" | "bale"> };

/** The caller's own zone and the one their dates are drawn in (TZ-1-c, auth-api `contract.time-zone.md`); `applied` on a save. */
export type MeTimeZone = { timezone: string | null; source: TimeZoneSource | null; resolved: ResolvedTimeZone; applied?: boolean };

/** One place the account is signed in (SES-1-a): a browser, or a bot chat with its Mini App. `id` is opaque. */
export type ActiveSession = {
  id: string;
  current: boolean;
  surface: "web" | "telegram" | "bale";
  ipAddress: string | null;
  userAgent: string | null;
  lastActiveAt: string;
};

/** The caller's own account — spread into `authApi` (`lib/auth-api.ts`). */
export const accountCalls = {
  /** The caller's own account plus the accounts they may switch to (F-0206). */
  async listAccounts() { return request<SwitchGroup>("/auth/accounts", { method: "GET" }); },
  /** The resellers the caller owns — one "my reseller panel" entry each (F-061-f). */
  async ownedResellers() { return request<{ resellers: OwnedReseller[] }>("/auth/handoff", { method: "GET" }); },
  /** A single-use code for one of them, and the origin of its panel to spend it on. */
  async issueHandoff(tenantId: string) { return request<{ origin: string; code: string; expiresIn: number }>("/auth/handoff", { method: "POST", body: JSON.stringify({ tenantId }) }); },
  /**
   * Spend that code on the reseller's own domain. `alreadySignedIn`: this
   * domain already holds a live session of the same account, which is kept —
   * no new session, no token here (F-061-o); the panel restores it from its cookie.
   */
  async redeemHandoff(code: string) {
    const result = await request<AuthResult | { alreadySignedIn: true }>("/auth/handoff/redeem", { method: "POST", body: JSON.stringify({ code }) });
    if ("accessToken" in result) setAccessToken(result.accessToken);
    return result;
  },
  /** The caller's own identity and authority (F-097). */
  async me() { return request<Me>("/auth/me", { method: "GET" }); },
  /** The platform owner finds a user by phone, username or email (F-018-ad): `user.search` on the platform's tenant. */
  async searchUsers(q: string) { return request<{ users: UserSearchHit[] }>(`/auth/users?q=${encodeURIComponent(q)}`, { method: "GET" }); },
  /** Mails a code to `email` (F-035-g); nothing is written until `confirmEmail`. */
  async requestEmailCode(email: string) { return request<OtpQueued>("/auth/me/email", { method: "POST", body: JSON.stringify({ email }) }); },
  async confirmEmail(email: string, otpCode: string) { return request<{ email: string; emailVerifiedAt: string }>("/auth/me/email/verify", { method: "POST", body: JSON.stringify({ email, otpCode }) }); },
  /** Which messenger the caller's notices take (F-601-u); unchosen reads as `both`, with `chosen: false`. */
  async messenger() { return request<MeMessenger>("/auth/me/messenger", { method: "GET" }); },
  async saveMessenger(messenger: NoticeMessenger) { return request<MeMessenger>("/auth/me/messenger", { method: "PUT", body: JSON.stringify({ messenger }) }); },
  /** The caller's zone, and the resolved one dates are drawn in (TZ-1-c). */
  async timeZone() { return request<MeTimeZone>("/auth/me/timezone", { method: "GET" }); },
  /** `user` picks (null clears the pick); `browser` reports, and is not stored over a pick (`applied: false`). */
  async saveTimeZone(zone: string | null, source: TimeZoneSource) { return request<MeTimeZone>("/auth/me/timezone", { method: "PUT", body: JSON.stringify({ zone, source }) }); },
  /** The caller's display preferences, every key with defaults filled in (UX-1-k). */
  async uiPreferences() { return request<UiPreferences>("/auth/me/ui-preferences", { method: "GET" }); },
  /** Any subset, validated strictly; answers every key after the write. */
  async saveUiPreferences(patch: UiPreferencesPatch) { return request<UiPreferences>("/auth/me/ui-preferences", { method: "PATCH", body: JSON.stringify(patch) }); },
  /** Renames the caller (UX-1-t, auth-api v41): the register form's rules; `GET auth/me` then answers the new name. */
  async renameMe(fullName: string) { return request<{ fullName: string }>("/auth/me/name", { method: "PUT", body: JSON.stringify({ fullName }) }); },
  /** Changes the password signed in (UX-1-t): a wrong `currentPassword` is 400 `wrong_password`; this session stays. */
  async changePassword(currentPassword: string, newPassword: string, endOtherSessions: boolean) { return request<{ otherSessionsEnded: number }>("/auth/me/password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword, endOtherSessions }) }); },
  /** Every place this account is signed in, the current one first (SES-1-a). */
  async activeSessions() { return request<{ sessions: ActiveSession[] }>("/auth/sessions", { method: "GET" }); },
  /** End that place for good: its sessions, its switcher entry, and — on a bot chat — this account's link to it. */
  async terminateSession(id: string) { return request<{ terminated: number }>("/auth/sessions/terminate", { method: "POST", body: JSON.stringify({ id }) }); },
  async terminateOtherSessions() { return request<{ terminated: number }>("/auth/sessions/terminate-others", { method: "POST" }); },
  /**
   * Add another account to the group (F-0205) — proved by a code sent to that
   * account's own phone, or by that account's own password.
   */
  async addAccountOtpRequest(phoneNumber: string, captchaToken: string, channel?: OtpChannel) { return request<OtpRequestResult>("/auth/accounts/add/otp/request", { method: "POST", body: JSON.stringify({ phoneNumber, ...(channel ? { channel } : {}) }) }, captchaToken); },
  /** Where a person stands (BAN-1-d) — `restriction.assign` or `user.ban`, own tenant. */
  async userStatus(userId: string) { return request<UserStatusView>(`/auth/users/${encodeURIComponent(userId)}/status`, { method: "GET" }); },
  /** Restrict, ban or lift, with the reason the person is shown (ADR-0133). */
  async setUserStatus(userId: string, status: AccountStatus, reason?: string) { return request<UserStatusView>(`/auth/users/${encodeURIComponent(userId)}/status`, { method: "PUT", body: JSON.stringify({ status, reason }) }); },
  async addAccountOtpVerify(phoneNumber: string, otpCode: string) { return request<{ groupId: string; added: boolean; userId: string }>("/auth/accounts/add/otp/verify", { method: "POST", body: JSON.stringify({ phoneNumber, otpCode }) }); },
  async addAccountPassword(identifier: string, password: string, captchaToken: string) { return request<{ groupId: string; added: boolean; userId: string }>("/auth/accounts/add/password", { method: "POST", body: JSON.stringify({ identifier, password }) }, captchaToken); },
  /**
   * Become another member (F-0207). The session this tab is holding is revoked
   * server-side by this call, so the returned token replaces it here — there is
   * no moment where the old one is still usable.
   */
  async switchAccount(userId: string) { const result = await request<AuthResult & { userId: string; fullName: string }>("/auth/accounts/switch", { method: "POST", body: JSON.stringify({ userId }) }); setAccessToken(result.accessToken); return result; },
  /**
   * Remove a member from the group (F-0208).
   *
   * Scoped to **this browser** (ADR-0015): the group the server changes is the
   * one this browser's `device_id` cookie names, so nothing here touches a set
   * the same person built inside a bot chat.
   *
   * `userId` may be the current account, which is how it leaves. The browser
   * then falls back to another member — `switchedTo`, with a fresh token pair,
   * exactly as a switch — or, with none left, is signed out. Either way the old
   * token is dead, so the caller reloads rather than carry on with it.
   */
  async removeAccount(userId: string) {
    const result = await request<{ userId: string; removed: boolean; switchedTo?: { userId: string; fullName: string } } & Partial<AuthResult>>("/auth/accounts/remove", { method: "POST", body: JSON.stringify({ userId }) });
    if (result.accessToken) setAccessToken(result.accessToken);
    return result;
  },
};
