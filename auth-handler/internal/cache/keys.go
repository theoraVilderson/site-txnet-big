package cache

// The Go half of the Redis key catalogue (ADR-0036, C-03).
//
// C-03 has said since it was written that every Redis key is built through
// `RedisKeys.*` in Node "or the matching auth-handler config". There was no
// matching builder: this gateway concatenated `keyPrefix + "session:" + id`
// inline, which is exactly the raw key string the convention forbids, in the
// one language its check block did not cover.
//
// Only the families this process actually touches are here. The tenant-derived
// ones cannot be: they read a request-scoped tenant that does not exist in Go
// (ADR-0024), and `session:` is deliberately tenant-free precisely so that a
// process with no tenant can build it.
//
// `contracts/redis/keyspace.json` declares the names and
// `keys_contract_test.go` holds these functions to it, the same way
// `shared-core/src/lib/redis/keys.spec.ts` holds the TypeScript half. A
// disagreement between the two is silent — the lookup misses, and a miss is
// read as "revoked", so every request 401s while the sessions sit there under
// a slightly different name.

// SessionKey is the liveness marker for one session, prefix included.
//
// The prefix is passed rather than read from config so this stays a pure
// function of its inputs: the one thing worth testing about a key builder is
// that it produces the same string as its twin in the other language, and a
// function that reaches for ambient config cannot be asked that cheaply.
func SessionKey(prefix, sessionID string) string {
	return prefix + "session:" + sessionID
}

// UserSessionsKey is the SET of a user's live session ids.
//
// Not read by this gateway today — `identity` writes it so every session can be
// dropped without a scan. It is declared here because the contract declares it,
// and a builder that exists is what stops the next reader from hand-writing the
// string a third time.
func UserSessionsKey(prefix, userID string) string {
	return prefix + "user:" + userID + ":sessions"
}

// OtpChannelKey is the token authorizing one OTP realtime subscription.
//
// Written by `auth-service`, read by `gateway-service`. Declared here for the
// same reason as UserSessionsKey: the catalogue is one catalogue.
func OtpChannelKey(prefix, channelID string) string {
	return prefix + "otp:channel:" + channelID
}
