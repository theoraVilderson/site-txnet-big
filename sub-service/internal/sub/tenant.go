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

// tenantState is `TenantStatusState` as Redis holds it.
type tenantState struct {
	Status      string  `json:"status"`
	GraceEndsAt *string `json:"graceEndsAt"`
	Onboarding  bool    `json:"onboarding"`
}

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
	if s.Onboarding && knownStatus(s.Status) {
		return false
	}
	switch s.Status {
	case "suspended":
		return withinGrace(s.GraceEndsAt, now)
	case "terminated":
		return false
	default:
		// `trial`, `active`, and a status this file does not know: the TS
		// parser reads an unknown one as no state, which refuses nobody.
		return true
	}
}

func knownStatus(s string) bool {
	switch s {
	case "trial", "active", "suspended", "terminated":
		return true
	}
	return false
}

// withinGrace is the matrix's `hold`: allowed up to and including
// `graceEndsAt`, refused after it or with none. An unparseable time is
// refused, as `Date.parse` giving NaN is on the TypeScript side.
func withinGrace(graceEndsAt *string, now time.Time) bool {
	if graceEndsAt == nil {
		return false
	}
	end, err := time.Parse(time.RFC3339Nano, *graceEndsAt)
	if err != nil {
		return false
	}
	return !now.After(end)
}
