/**
 * The declared home, on the TypeScript side, of every HTTP header name that
 * crosses a process boundary in this platform (ADR-0036, C-04).
 *
 * **Why a file and a fixture rather than just a file.** The same seven
 * identity headers are written in Go (`auth-handler`), read in TypeScript
 * (`gateway-service`) and named twice more in Traefik YAML — a forward list
 * and a strip list. No import joins those three, so they were kept in step by
 * comments, and they had already drifted: `X-Actor-Id` sat in the Traefik
 * strip list while nothing wrote or read it. `contracts/http/wire.json` is
 * what an import would have been. This file is the TypeScript half of it, and
 * `wire.contract.spec.ts` is what makes the two halves the same list rather
 * than two lists that look alike.
 *
 * **Casing.** The identity headers keep the spelling `auth-handler` writes,
 * because that is what Traefik's lists have to match character for character.
 * Request headers are declared lowercase because that is how Node exposes an
 * inbound header name on `req.headers`. Both are correct; what would not be
 * correct is the same header appearing here twice in two cases, which is the
 * drift this file exists to stop. Read an inbound header with
 * {@link headerValue}, never by indexing with a literal.
 */

/**
 * Set by `auth-handler` on a 2xx from `/validate`, forwarded by Traefik and
 * stripped from the inbound request. A consumer may trust these and only
 * these; anything the client sent under the same name is gone by the time a
 * request reaches a service (`platform/forward-auth/contract.md`).
 */
export const IdentityHeaders = {
  userId: 'X-User-Id',
  tenantId: 'X-Tenant-Id',
  roleId: 'X-Role-Id',
  sessionId: 'X-Session-Id',
  permissions: 'X-User-Permissions',
  impersonated: 'X-Impersonated',
  impersonatedBy: 'X-Impersonated-By',
} as const;

/**
 * The five that a successful `/validate` always carries. The impersonation
 * pair is conditional, so a consumer checking "did the gate identify someone"
 * checks these and not the whole set.
 */
export const ALWAYS_SET_IDENTITY_HEADERS = [
  IdentityHeaders.userId,
  IdentityHeaders.tenantId,
  IdentityHeaders.roleId,
  IdentityHeaders.sessionId,
  IdentityHeaders.permissions,
] as const;

/** Written only while an admin is impersonating (`audit` unit). */
export const IMPERSONATION_HEADERS = [
  IdentityHeaders.impersonated,
  IdentityHeaders.impersonatedBy,
] as const;

/**
 * The marker on a 2xx from `/validate-optional` that identified nobody
 * (ADR-0031).
 *
 * It is not an identity header and must never be read as one: it is the
 * evidence that the gate *ran*. Without it "nobody is signed in" and "the
 * Traefik router lost its middleware" are the same absence of headers, and the
 * second silently downgrades every authenticated socket to an anonymous one.
 * Which is why it is forwarded *and* stripped like the identity set — a header
 * read as proof the gate ran is a header a caller must not be able to set.
 */
export const AUTH_ANONYMOUS_HEADER = 'X-Auth-Anonymous';

/**
 * Headers a caller sends and a service reads. Lowercase, because that is the
 * form Node hands back.
 *
 * The tenant header is deliberately **not** here. `x-tenant-id` and
 * `X-Tenant-Id` are one name — HTTP header names are case-insensitive — and
 * `bot-service` sending the first while `auth-handler` writes the second is
 * two spellings of one string, which is the thing this file exists to stop.
 * Both directions use {@link IdentityHeaders.tenantId}; {@link headerValue}
 * lowercases on the way in, so a reader never has to care.
 */
export const RequestHeaders = {
  serviceToken: 'x-service-token',
  captchaToken: 'x-captcha-token',
  botChatId: 'x-bot-chat-id',
  botPlatform: 'x-bot-platform',
} as const;

/**
 * Set by Traefik rather than by anything in this repo.
 *
 * There is no drift to prevent — nothing here writes it — so it is not part of
 * the identity contract and is not in {@link ALL_WIRE_HEADERS}. It is declared
 * only so the codebase spells it once, which is what C-04 asks for, and so a
 * reader is reminded what it is worth: Traefik sets it, and anything that
 * bypasses Traefik can forge it, so it is fit for a rate-limit bucket and
 * never for an authorization decision.
 */
export const FORWARDED_FOR_HEADER = 'X-Forwarded-For';

/** Every header name declared here, in the fixture's order. */
export const ALL_WIRE_HEADERS = [
  ...Object.values(IdentityHeaders),
  AUTH_ANONYMOUS_HEADER,
  ...Object.values(RequestHeaders),
] as const;

/**
 * One inbound header value, or `undefined` when it is absent, blank, or
 * ambiguous.
 *
 * Takes the declared constant in its declared casing and lowercases it here,
 * so a caller never has to write a second spelling of a name this file already
 * owns.
 *
 * Three things are `undefined` rather than a value, and each is a decision:
 *
 * - **absent** — the ordinary case.
 * - **empty or whitespace-only** — a header that arrived carrying nothing is
 *   not a value. Treating it as one is how a blank `X-Tenant-Id` becomes a
 *   request scoped to tenant `""`.
 * - **repeated** — Node hands back an array when a header arrived more than
 *   once, and picking one of them is picking for the attacker. A caller that
 *   sent two `x-captcha-token` headers gets neither; `captcha.guard.ts` has
 *   worked this way since it was written, and this function is where that
 *   rule now lives for every header.
 */
export function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const raw = headers[name.toLowerCase()];
  if (Array.isArray(raw)) {
    // One entry is the same thing as a plain string; more than one is a
    // question this function must not answer.
    if (raw.length !== 1) return undefined;
    const only = raw[0]?.trim();
    return only === '' ? undefined : only;
  }
  const trimmed = raw?.trim();
  return trimmed === '' ? undefined : trimmed;
}
