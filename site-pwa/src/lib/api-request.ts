import { ApiError } from "./api-error";
import { apiLanguage } from "./api-language";

/**
 * The one place this app unwraps a backend answer.
 *
 * Every service behind `api.<domain>` installs the same `shared-core` pair — an
 * `I18nExceptionFilter` that translates what is thrown and a
 * `ResponseInterceptor` that wraps what is returned — so `{ok, data}` and
 * `{ok: false, msg, ref, fieldErrors}` are one envelope, not one per service.
 * Reading it twice is how the two copies drift: the second client learns about
 * a new envelope field only if somebody remembers it exists.
 *
 * This was `auth-api.ts`'s private `request()` until `billing-api.ts` needed the
 * same thing (F-093-c). It is extracted rather than copied, and the extraction
 * changed no call site: `request()` kept its signature and delegates here.
 */
export interface ApiClientConfig {
  /** Absolute, including the service's own prefix — `…/api` or `…/api/billing`. */
  baseUrl: string;
  /**
   * Named in the `unreachable` detail so a console line says which service
   * never answered. Not shown to a user: `unreachable` carries no server text.
   */
  service: string;
  /**
   * Read on every call, never captured. Refresh *rotates* the access token
   * (F-0209), so a client holding the one it was built with sends a dead
   * credential after the first rotation.
   */
  credential?: () => string | null | undefined;
  /**
   * Called once when a call is refused for a reason a refresh can mend
   * ({@link REFRESH_REASONS}), with the token that call carried, before it is
   * retried. It must leave `credential()` answering a live token — and may do so
   * without refreshing when that token was already replaced (another call, the
   * socket, or another tab). Absent means no retry. Only `auth-api` can mint
   * one, so every client passes `auth-api`'s `refreshCredential`.
   */
  onCredentialRefused?: (staleToken: string | null) => Promise<void>;
  /**
   * Resolves when no credential is being established — the page-load refresh
   * or any other. A call with no credential waits for it first, so a page that
   * fetches on mount does not race the session provider. Never starts one.
   */
  credentialSettled?: () => Promise<void>;
}

/** The `error.reason` that means "refresh once and retry" (ADR-0043). Never `msg`: that is translated. */
export const PERMISSIONS_CHANGED = "permissionsChanged";
/** The access token only aged out; the refresh cookie still mends it. Same single refresh and retry. */
export const TOKEN_EXPIRED = "tokenExpired";
/** The session is gone: signed out, or rotated by a refresh elsewhere — only the cookie can tell. */
export const SESSION_REVOKED = "sessionRevoked";
/** No credential was sent — a call made before the session was established. */
export const AUTHORIZATION_REQUIRED = "authorizationRequired";
export const REFRESH_REASONS: ReadonlySet<string> = new Set([
  PERMISSIONS_CHANGED,
  TOKEN_EXPIRED,
  SESSION_REVOKED,
  AUTHORIZATION_REQUIRED,
]);

export type ApiCall = <T>(
  path: string,
  init?: RequestInit,
  extraHeaders?: Record<string, string | undefined>,
) => Promise<T>;

/**
 * A caller for one service. The answer is either `data` or an {@link ApiError}.
 *
 * The backend has already translated `msg` and each `fieldErrors[].message`
 * into the language this app asked for, so a caller shows them as they are. The
 * two answers with no server text of their own — `fetch` threw, or the body had
 * no envelope — are marked `unreachable`, and the caller translates its own
 * line (`useApiErrorMessage`).
 */
export function createApiClient({
  baseUrl,
  service,
  credential,
  onCredentialRefused,
  credentialSettled,
}: ApiClientConfig): ApiCall {
  async function once<T>(
    path: string,
    init: RequestInit = {},
    extraHeaders?: Record<string, string | undefined>,
  ): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    const lang = apiLanguage();
    if (lang) headers.set("accept-language", lang);
    const token = credential?.();
    if (token) headers.set("authorization", `Bearer ${token}`);
    for (const [name, value] of Object.entries(extraHeaders ?? {})) {
      if (value) headers.set(name, value);
    }

    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, { ...init, headers, credentials: "include" });
    } catch (cause) {
      throw ApiError.unreachable(
        `${init.method ?? "GET"} ${path} did not reach ${service}`,
        cause,
      );
    }

    const body = await response.json().catch(() => null);
    if (body === null || typeof body !== "object") {
      // A 2xx whose body cannot be read is still a success — an empty answer to
      // a call that wanted nothing back. A failure with no readable body has no
      // message in it, so nothing translated came back to show.
      if (!response.ok) {
        throw ApiError.unreachable(`${path} answered ${response.status} without a JSON envelope`);
      }
      return undefined as T;
    }
    if (!response.ok || body.ok === false) {
      // No `msg` means nothing translated came back — a bare gateway 502, say.
      if (typeof body.msg !== "string" || body.msg.length === 0) {
        throw ApiError.unreachable(`${path} answered ${response.status} with no message`);
      }
      const detail = body.error as { reason?: unknown } | null | undefined;
      throw new ApiError(body.msg, {
        status: response.status,
        ref: typeof body.ref === "string" ? body.ref : undefined,
        reason: typeof detail?.reason === "string" ? detail.reason : undefined,
        fieldErrors: Array.isArray(body.fieldErrors)
          ? (body.fieldErrors as unknown[])
              .map((f) => f as { path?: unknown; message?: unknown })
              .filter((f) => typeof f?.message === "string")
              .map((f) => ({ path: String(f.path ?? ""), message: f.message as string }))
          : [],
      });
    }
    return body.data as T;
  }

  /**
   * One retry, for one refusal a refresh can mend: permissions changed
   * (ADR-0043), the access token expired, or its session was rotated by a
   * refresh elsewhere. The credential is refreshed — or adopted, when it was
   * already replaced — and the call is sent once more with whatever
   * `credential()` now answers. A refused call never reached its handler, so a
   * retried POST runs once. A second refusal is thrown as it is, never looped,
   * and a refresh that fails throws the original refusal.
   */
  return async function call<T>(
    path: string,
    init: RequestInit = {},
    extraHeaders?: Record<string, string | undefined>,
  ): Promise<T> {
    if (credentialSettled && !credential?.()) await credentialSettled();
    const sent = credential?.() ?? null;
    try {
      return await once<T>(path, init, extraHeaders);
    } catch (error) {
      if (
        !onCredentialRefused ||
        !(error instanceof ApiError) ||
        !error.reason ||
        !REFRESH_REASONS.has(error.reason)
      ) {
        throw error;
      }
      try {
        await onCredentialRefused(sent);
      } catch {
        throw error;
      }
      return once<T>(path, init, extraHeaders);
    }
  };
}
