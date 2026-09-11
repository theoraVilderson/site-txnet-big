package handlers

// The declared home, on the Go side, of every header this gateway writes
// (ADR-0036, C-04).
//
// These were inline string literals inside Validate, which is the one place in
// the platform that *writes* them — everything else reads them, and the
// readers live in another language and in Traefik YAML. Nothing joined the
// four spellings, and they had already drifted: `X-Actor-Id` sat in Traefik's
// strip list while no writer and no reader had ever used it.
//
// `contracts/http/wire.json` is the language-neutral home; `headers_contract_test.go`
// holds this file to it, `shared-core/src/lib/http/wire.contract.spec.ts` holds
// the TypeScript half to it, and `tools/contracts.py` holds the Traefik lists
// to it (F-072). The fixture is hand-written rather than generated because
// Traefik reads YAML and has no toolchain that could consume generated code.
const (
	// HeaderUserID names the person the token is about (`sub`).
	HeaderUserID = "X-User-Id"
	// HeaderTenantID scopes every upstream query. Blank is never valid.
	HeaderTenantID = "X-Tenant-Id"
	// HeaderRoleID is the role the policy engine resolved the request against.
	HeaderRoleID = "X-Role-Id"
	// HeaderSessionID names the *grant* rather than the person, so a consumer
	// holding a connection that outlives the token can re-ask the question
	// this handler answered once (F-067-h).
	HeaderSessionID = "X-Session-Id"
	// HeaderUserPermissions is the claimed permission set, comma-joined.
	HeaderUserPermissions = "X-User-Permissions"
	// HeaderImpersonated is "true" only while an admin is impersonating.
	HeaderImpersonated = "X-Impersonated"
	// HeaderImpersonatedBy names the admin behind an impersonated request.
	HeaderImpersonatedBy = "X-Impersonated-By"
)

// HeaderAnonymous marks a 2xx from the optional gate that identified nobody.
//
// It exists so the gateway can tell "the gate ran and this caller is not
// signed in" from "the gate never ran". Without it the two are the same thing
// downstream — an upgrade with no identity headers — and a Traefik router
// that lost its middleware would silently turn every authenticated socket
// into an anonymous one, which looks to a user like a panel that has stopped
// updating rather than like a failure.
//
// Traefik must forward it (`authResponseHeaders`) **and** strip the
// client-supplied copy (`strip-fake-headers`), like every identity header.
// Forwarded but not stripped is a header a caller can set, and this one is
// read as evidence that the gate ran.
const HeaderAnonymous = "X-Auth-Anonymous"

// AlwaysSetIdentityHeaders is what a successful /validate always carries.
//
// The impersonation pair is conditional and therefore not here: a consumer
// asking "did the gate identify someone" must check a set that is present on
// every success, or an ordinary signed-in request looks like a failure.
var AlwaysSetIdentityHeaders = []string{
	HeaderUserID,
	HeaderTenantID,
	HeaderRoleID,
	HeaderSessionID,
	HeaderUserPermissions,
}

// ImpersonationHeaders are written only while an admin is impersonating.
var ImpersonationHeaders = []string{
	HeaderImpersonated,
	HeaderImpersonatedBy,
}
