/**
 * The Redis keyspace prefix: one algorithm, one default namespace, one version
 * (ADR-0036, C-03, C-04).
 *
 * **Why this file exists, in the order the problem was found.** Every service
 * assembled `${namespace}:${version}:` for itself, `auth-handler` assembled it
 * again in Go, and a third transcription of the Go function lived inside a
 * TypeScript spec so the two could be compared. Three copies of one string
 * operation, kept in step by comments.
 *
 * That would have been merely untidy. What made it expensive is that the
 * *value* disagreed as well: four `env.validation.ts` files and `config.go`
 * defaulted `v1`, `.env` said `v2`, and `docker-compose.main.yml` defaulted
 * `v3` across five services. Which one a container got depended on whether
 * `.env` reached it, so the fleet was split across two live keyspaces — and it
 * was: 8 sessions under `v1` and 7 under `v2` when F-075 measured it. A user
 * whose session lived in the half a given service was not reading was signed
 * out by that service and signed in by the next.
 *
 * **The version is a deliberate weapon, which is why it must have one value.**
 * `REDIS_KEYSPACE_VERSION` exists so the entire keyspace can be abandoned at
 * once — a forced logout of everybody — by changing one thing. A default that
 * disagrees with itself does that by accident, to half the fleet, with nothing
 * red anywhere.
 *
 * `contracts/redis/keyspace.json` is the language-neutral home; this file is
 * the TypeScript half and `auth-handler/internal/config/config.go` is the Go
 * half, each held to it by a test.
 */

/**
 * The keyspace every service shares.
 *
 * Unified on `v2` on the user's call, 2026-09-11 (ADR-0036): it is the value
 * `.env` already carried, so the sessions living in dev survived the change.
 * The `v1` half did not, and that is the documented cost of having let the
 * defaults drift.
 */
export const REDIS_KEYSPACE_VERSION_DEFAULT = 'v2';

/** The namespace every service shares when nothing overrides it. */
export const REDIS_KEY_NAMESPACE_DEFAULT = 'txnet:auth';

/**
 * Strip trailing colons off a namespace.
 *
 * Exported because the Node side normalises in `envSchema` rather than here —
 * a service only ever sees the already-clean value — while Go normalises
 * inside its prefix builder. Both must do it, or `REDIS_KEY_NAMESPACE` with a
 * stray trailing colon splits the keyspace between the two languages, which is
 * the same mass-logout failure arriving by a different route.
 */
export function normalizeRedisNamespace(namespace: string): string {
  return namespace.replace(/:+$/, '');
}

/**
 * `<namespace>:<version>:` — the prefix ioredis applies to every key of every
 * command, and the string `auth-handler` concatenates by hand because it holds
 * no ioredis.
 *
 * Takes the raw namespace and normalises it, so this one function is the whole
 * algorithm on the TypeScript side and there is nothing left for a caller to
 * get subtly different.
 */
export function buildRedisKeyPrefix(
  namespace: string = REDIS_KEY_NAMESPACE_DEFAULT,
  version: string = REDIS_KEYSPACE_VERSION_DEFAULT,
): string {
  return `${normalizeRedisNamespace(namespace)}:${version}:`;
}
