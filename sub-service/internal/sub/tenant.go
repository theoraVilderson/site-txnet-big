package sub

import (
	"encoding/json"
	"time"
)

// The tenant gate (F-113-e): `TenantStatusPolicy`'s `subscriptionLink` column
// (tenant `rules.md`; the executable matrix is shared-core
// `tenant/status-policy.ts`). Only this one column is copied here, because it
// is the only capability `/sub` has:
//
//	trial / active   yes
//	suspended        until `graceEndsAt` (the tenant's end users keep their
//	                 links through the hold, not after it)
//	terminated       no
//	+ onboarding     no — a reseller with no proven domain serves nobody
//
// The state is the one tenant-service's `TenantStatusListener` writes to
// `tenant:status:<tenantId>`. **A missing or unreadable state refuses
// nobody** (rules.md #6): the listener rewrites every tenant on connect, and
// refusing on a miss would empty every link on the platform with Redis.

// tenantState is `TenantStatusState` as Redis holds it. Each field is read
// the way shared-core's `parseTenantStatusState` reads it, not by Go's
// types: a status that is not a known string is no state at all, a grace that
// is not a string is none, and onboarding is on only when it is `true` — so a
// wrongly typed field never turns the whole value into "no state".
type tenantState struct {
	Status      any `json:"status"`
	GraceEndsAt any `json:"graceEndsAt"`
	Onboarding  any `json:"onboarding"`
}

// linkRule is one cell of the column: the matrix's true, false or `hold`.
type linkRule int

const (
	linkRefused linkRule = iota
	linkAllowed
	// linkHold is allowed up to and including `graceEndsAt`, refused after it
	// or with none.
	linkHold
)

// subscriptionLinkColumn is `TenantStatusPolicy[status].subscriptionLink`, and
// subscriptionLinkOnboarding `TenantOnboardingPolicy.subscriptionLink`. Both
// are held to TypeScript by `contracts/tenant/subscription-link.json`
// (F-113-g); a status missing here is one the TS parser rejects.
var subscriptionLinkColumn = map[string]linkRule{
	"trial":      linkAllowed,
	"active":     linkAllowed,
	"suspended":  linkHold,
	"terminated": linkRefused,
}

const subscriptionLinkOnboarding = linkRefused

// subscriptionLinkAllowed judges one raw `tenant:status` value at now.
// Empty is "no key".
func subscriptionLinkAllowed(raw string, now time.Time) bool {
	if raw == "" {
		return true
	}
	var s tenantState
	if err := json.Unmarshal([]byte(raw), &s); err != nil {
		return true
	}
	status, _ := s.Status.(string)
	rule, known := subscriptionLinkColumn[status]
	if !known {
		// The TS parser reads an unknown status as no state: refuses nobody.
		return true
	}
	grace, _ := s.GraceEndsAt.(string)
	if !applies(rule, grace, now) {
		return false
	}
	return s.Onboarding != true || applies(subscriptionLinkOnboarding, grace, now)
}

func applies(rule linkRule, graceEndsAt string, now time.Time) bool {
	if rule == linkHold {
		return withinGrace(graceEndsAt, now)
	}
	return rule == linkAllowed
}

// withinGrace is the matrix's `hold`: allowed up to and including
// `graceEndsAt`, refused after it or with none. An unparseable time is
// refused, as `Date.parse` giving NaN is on the TypeScript side. Empty is
// none.
func withinGrace(graceEndsAt string, now time.Time) bool {
	if graceEndsAt == "" {
		return false
	}
	end, err := time.Parse(time.RFC3339Nano, graceEndsAt)
	if err != nil {
		return false
	}
	return !now.After(end)
}
