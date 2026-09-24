package cache

import "strings"

// The `sub:` family of the Redis key catalogue (redis-keyspace contract,
// C-03). `sub-service` is the only process that reads or writes it, so it is
// Go-only and not declared in `contracts/redis/keyspace.json`, which holds the
// families two languages build.
//
// Every builder takes the prefix rather than reading config, as
// `auth-handler/internal/cache/keys.go` does: a key builder is then a pure
// function of its inputs.

// Prefix is `${REDIS_KEY_NAMESPACE}:${REDIS_KEYSPACE_VERSION}:` — the same
// algorithm as `auth-handler`'s `buildRedisKeyPrefix` and shared-core's
// `keyspace.ts` (ADR-0036): trailing colons stripped from the namespace, so an
// operator typo cannot move this service into a keyspace of its own.
func Prefix(namespace, version string) string {
	return strings.TrimRight(namespace, ":") + ":" + version + ":"
}

// RenderKey is one cached `/sub` answer (F-113-c): what a request knows before
// any Postgres read — the token's hash, the format asked for and the host —
// under the renderer's revision. The host is last because it is the only part
// not made of a closed alphabet.
func RenderKey(prefix, revision, tokenHash, format, host string) string {
	return prefix + "sub:render:r" + revision + ":" + tokenHash + ":" + format + ":" + host
}

// Change kinds, as the `sub_invalidate` notification names them (migration
// `20260924000700_sub_is_told_what_changed`).
const (
	KindPanel  = "panel"
	KindGrant  = "grant"
	KindTenant = "tenant"
)

// ChangedKey holds the Redis time (microseconds) at which this service last
// heard that one panel, Grant or tenant changed. A cached render built before
// that time is not served.
func ChangedKey(prefix, kind, id string) string {
	return prefix + "sub:changed:" + kind + ":" + id
}

// ChangedAllKey is the stamp that outdates every cached render at once. It is
// written when a listener (re)connects, because a notification sent while no
// listener was connected is lost.
func ChangedAllKey(prefix string) string {
	return prefix + "sub:changed:all"
}
