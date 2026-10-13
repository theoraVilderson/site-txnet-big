// Browser calls auth-service at `/api/auth` on the page's own domain, which
// Traefik routes to the service — no Next.js proxy hop, and no CORS: the
// refresh cookie is first-party to whichever domain the panel is on (ADR-0060).
//
// This module owns the access token and the one refresh every client shares;
// the other `./auth/` modules set the token only through `setAccessToken` (FE-1-h).
import { RequestHeaders } from "@/generated/wire";
import { API_BASE as API_URL } from "../api-origin";
import { createApiClient } from "../api-request";
import type { AuthResult } from "./sign-in";

let accessToken: string | null = null;

/** Adopt the token a sign-in, a switch or a sign-out left (null: none). */
export function setAccessToken(token: string | null): void {
  accessToken = token;
}

/** "Sign in as this user" (AC-1-i): whom this tab is signed in as, until when, and the page to come back to. */
export type Impersonation = { userId: string; name: string; endsAt: number; returnTo: string };

/**
 * The impersonation this tab holds, and the admin's own token beside it.
 *
 * Memory only, like `accessToken` — a reload ends it, and the refresh cookie
 * (still the admin's: impersonation mints none) brings the admin back. It has
 * no refresh token, so a refusal a refresh would mend ends it instead
 * (`refreshCredential`), and the refused call is never sent again: a retry
 * would carry the admin's token and run the user's click as the admin.
 */
let impersonation: Impersonation | null = null;

/** The admin's own token, kept beside the user's while `impersonation` is set. */
let ownToken: string | null = null;

const impersonationListeners = new Set<() => void>();

/** The impersonation is over, on purpose or because its token was refused. */
export class ImpersonationEnded extends Error {
  constructor() {
    super("impersonation ended");
    this.name = "ImpersonationEnded";
  }
}

function backToOwnToken(): void {
  if (!impersonation) return;
  accessToken = ownToken;
  ownToken = null;
  impersonation = null;
  for (const listener of impersonationListeners) listener();
}

/**
 * **One refresh for the whole browser.** Refresh *rotates* the session: the one
 * it replaces is revoked on the spot. So two refreshes racing with the same
 * cookie sign the loser out, and a tab that refreshes retires the token every
 * other tab holds. Three things make calls, the socket and several tabs live on
 * one session:
 *
 * - in this tab, every refresh — a refused call, the socket, a stale role — is
 *   the same in-flight promise;
 * - across tabs, `navigator.locks` lets one refresh run at a time;
 * - the new token is broadcast (memory to memory, never storage), and a tab
 *   adopts it when it names the same user, so it retries on it instead of
 *   rotating the session out from under the tab that just refreshed.
 *
 * `/auth/refresh` itself is neither behind the gate nor behind `AuthGuard`, so
 * it can never answer a refusal this retries and this can never wait on itself.
 */
let credentialRefresh: Promise<void> | null = null;

/** Any refresh in flight — the page load's or a later one — settled either way. */
let pending: Promise<void> | null = null;

function track<T>(p: Promise<T>): Promise<T> {
  const settled = p.then(
    () => undefined,
    () => undefined,
  );
  pending = settled;
  void settled.then(() => {
    if (pending === settled) pending = null;
  });
  return p;
}

/**
 * The panel's page load, held open until `PanelSessionProvider` has a session
 * or knows it has none. React runs a child's effect before its parent's, so a
 * sidebar entry fetching on mount went out before the page-load refresh had
 * even started — tokenless, refused 401, then retried. The provider opens this
 * from a layout effect, which runs before any child's `useEffect`; every
 * tokenless call waits for it, and nothing is sent to be refused.
 */
let sessionHold: { settled: Promise<void>; release: () => void } | null = null;

function holdUntilSession(): void {
  if (accessToken || sessionHold) return;
  let release!: () => void;
  const settled = new Promise<void>((r) => (release = r));
  sessionHold = { settled, release };
}

function releaseSessionHold(): void {
  sessionHold?.release();
  sessionHold = null;
}

const credentialSettled = (): Promise<void> =>
  Promise.all([sessionHold?.settled, pending]).then(() => undefined);

/** Told after each refresh, so what was rendered from the old token (`me`) is read again. */
const permissionsRefreshed = new Set<() => void>();

const AUTH_CHANNEL = "txnet:auth";

const REFRESH_LOCK = "txnet:auth-refresh";

const channel: BroadcastChannel | null = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(AUTH_CHANNEL);
// A channel keeps Node's event loop alive; a browser has no `unref`.
(channel as unknown as { unref?: () => void } | null)?.unref?.();

/** The `sub` a token names, read without verifying — only to tell whose token a broadcast carries. */
function subjectOf(token: string | null): string | null {
  const payload = token?.split(".")[1];
  if (!payload) return null;
  try {
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const sub = (JSON.parse(json) as { sub?: unknown }).sub;
    return typeof sub === "string" ? sub : null;
  } catch {
    return null;
  }
}

if (channel) {
  channel.onmessage = (event: MessageEvent) => {
    const next = (event.data as { accessToken?: unknown } | null)?.accessToken;
    if (typeof next !== "string") return;
    // Another tab rotated the admin's session: the token to come back to, not the one in use.
    if (impersonation) {
      if (ownToken && subjectOf(next) === subjectOf(ownToken)) ownToken = next;
      return;
    }
    // Another user's token is another account signed in elsewhere, not a rotation of ours.
    if (accessToken && subjectOf(next) === subjectOf(accessToken)) {
      accessToken = next;
    }
  };
}

function withRefreshLock(fn: () => Promise<void>): Promise<void> {
  const locks = typeof navigator === "undefined" ? undefined : (navigator as Navigator & { locks?: LockManager }).locks;
  return locks ? locks.request(REFRESH_LOCK, fn).then(() => undefined) : fn();
}

/**
 * Leave `accessToken` live. `stale` is the token a refused call carried: when
 * it has already been replaced — here, or by a broadcast — there is nothing to
 * refresh, and refreshing anyway would rotate the session again.
 */
function refreshCredential(stale: string | null = null): Promise<void> {
  // An impersonated token is never refreshed (it has no refresh token) and a
  // refused call is never retried on the admin's: it ends here (AC-1-i).
  if (impersonation) {
    backToOwnToken();
    return Promise.reject(new ImpersonationEnded());
  }
  // Replaced already — or the call carried none and a token has arrived since:
  // a sidebar call sent before the page-load refresh started, refused after it
  // finished. Rotating again would revoke the token that refresh just handed out.
  if (accessToken && accessToken !== stale) return Promise.resolve();
  // No token was sent while one is being established: that one is the answer.
  // A second refresh with the same cookie would sign the first out.
  if (!stale && pending) {
    return pending.then(() => (accessToken ? undefined : refreshCredential(stale)));
  }
  credentialRefresh ??= withRefreshLock(async () => {
    // Another tab may have rotated while this one waited for the lock.
    if (accessToken && accessToken !== stale) return;
    await sessionCalls.refresh();
    for (const listener of permissionsRefreshed) listener();
  }).finally(() => {
    credentialRefresh = null;
  });
  return credentialRefresh;
}

/**
 * Every call goes out with the language the user chose in this panel and comes
 * back as either `data` or an `ApiError` — {@link createApiClient} is where that
 * envelope is read, for this service and for `billing-api` alike.
 *
 * The credential is a callback rather than the value, because `accessToken`
 * above is reassigned by half the methods below: a client built with the value
 * would keep sending the token this module was loaded with.
 */
const call = createApiClient({
  baseUrl: API_URL,
  service: "auth-api",
  credential: () => accessToken,
  onCredentialRefused: (stale) => refreshCredential(stale),
  // `/auth/refresh` itself must not wait on the refresh it is.
  credentialSettled: () => credentialSettled(),
});

/**
 * `/auth/refresh` alone: no retry and no waiting for a credential, because it
 * *is* the thing every other call waits for and retries on.
 */
const rawCall = createApiClient({ baseUrl: API_URL, service: "auth-api", credential: () => accessToken });

export function rawRequest<T>(path: string, init: RequestInit): Promise<T> {
  return rawCall<T>(path, init);
}

/**
 * A login, with no credential at all. auth-service refuses a login that
 * carries a live session's token (409 `alreadyAuthenticated`), and a tab can
 * hold one while this browser's refresh cookie is dead — a rotation whose
 * answer was lost, say, to an auth-service restart. The page-load check then
 * shows the form, and with the token attached every submit was refused: a
 * dead end. A login is never an authenticated call; sent bare, it mints the
 * fresh session and cookie the browser needs.
 */
const loginCall = createApiClient({ baseUrl: API_URL, service: "auth-api" });

export function loginRequest<T>(path: string, init: RequestInit, captchaToken?: string): Promise<T> {
  return loginCall<T>(path, init, captchaToken ? { [RequestHeaders.captchaToken]: captchaToken } : undefined);
}

export async function request<T>(path: string, init: RequestInit = {}, captchaToken?: string): Promise<T> {
  return call<T>(path, init, captchaToken ? { [RequestHeaders.captchaToken]: captchaToken } : undefined);
}

/** The token's own calls: refresh, the page-load hold, impersonation — spread into `authApi` (`lib/auth-api.ts`). */
export const sessionCalls = {
  async refresh() {
    const result = await track(rawRequest<AuthResult>("/auth/refresh", { method: "POST", body: JSON.stringify({}) }));
    accessToken = result.accessToken;
    // Every rotation retires the token the other tabs hold; hand them this one.
    channel?.postMessage({ accessToken: result.accessToken });
    return result;
  },
  /** An access token for this page load, from the refresh cookie. Throws if there is no live session. */
  /**
   * The access token lives in memory only, so a full page load starts with none
   * — but the httpOnly `refresh_token` cookie is still there. This turns it back
   * into one through the same shared, cross-tab-locked refresh every refused
   * call uses: a page-load refresh of its own raced them with the same cookie,
   * and the loser — sometimes this one — was signed out. A token a sign-in on
   * this page already left is live, so nothing is rotated then.
   */
  async ensureSession(): Promise<void> { if (!accessToken) await refreshCredential(); },
  /** The one refresh every client and the socket run (see `credentialRefresh`). */
  refreshCredential,
  /**
   * Rotate the token this tab holds because the person's access moved
   * (`identity.access.changed`, AC-1-r) — the same single-flight refresh as a
   * refused call, so `onPermissionsRefreshed` re-reads `me` after it.
   */
  refreshAccess: () => refreshCredential(accessToken),
  /** Hold every tokenless call until `releaseSessionHold` — the panel's page load (see `sessionHold`). */
  holdUntilSession,
  releaseSessionHold,
  /** Resolves once no credential is being established; a call with none waits on it. */
  credentialSettled,
  /**
   * Run `listener` after each such refresh; returns the unsubscribe. The panel
   * session re-reads `me` here, so the menu follows the gate.
   */
  onPermissionsRefreshed(listener: () => void) {
    permissionsRefreshed.add(listener);
    return () => {
      permissionsRefreshed.delete(listener);
    };
  },
  /**
   * Sign in as `userId` for at most 30 minutes (AC-1-i, catalog §3.6): the
   * caller's own tenant, or — `tenantId` — a reseller's user under its consent
   * (F-117-e). The reason, at least 10 characters, goes in the audit row.
   */
  async impersonate(input: { userId: string; name: string; reasonNote: string; tenantId?: string | null; returnTo: string }) {
    const path = input.tenantId
      ? `/auth/tenants/${encodeURIComponent(input.tenantId)}/users/${encodeURIComponent(input.userId)}/impersonate`
      : `/auth/users/${encodeURIComponent(input.userId)}/impersonate`;
    const result = await request<AuthResult>(path, { method: "POST", body: JSON.stringify({ reasonNote: input.reasonNote }) });
    impersonation = { userId: input.userId, name: input.name, endsAt: Date.now() + result.expiresIn * 1000, returnTo: input.returnTo };
    ownToken = accessToken;
    accessToken = result.accessToken;
    for (const listener of impersonationListeners) listener();
  },
  /** End it on the server, as the user, then come back to the own token whatever the server said. */
  async endImpersonation() {
    if (!impersonation) return;
    try {
      await rawRequest("/auth/impersonate/end", { method: "POST", body: JSON.stringify({}) });
    } catch {
      // Expired or already ended: the server's session is over either way.
    } finally {
      backToOwnToken();
    }
  },
  /**
   * The end, for a page being unloaded: `keepalive` outlives the document, and
   * nothing waits for it. The reload that follows starts from the cookie.
   */
  endImpersonationOnUnload() {
    if (!impersonation || typeof fetch === "undefined") return;
    void fetch(`${API_URL}/auth/impersonate/end`, {
      method: "POST",
      keepalive: true,
      credentials: "include",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
      body: "{}",
    }).catch(() => undefined);
  },
  /** What this tab is signed in as, or null for the caller's own account. The same object until it changes. */
  impersonation(): Impersonation | null {
    return impersonation;
  },
  /** Run `listener` when an impersonation starts or ends; returns the unsubscribe. */
  onImpersonationChange(listener: () => void) {
    impersonationListeners.add(listener);
    return () => {
      impersonationListeners.delete(listener);
    };
  },
  getAccessToken() { return accessToken; },
};
