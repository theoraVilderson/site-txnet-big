package usermanager

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"network-service/internal/driver"
	"network-service/internal/driver/conformance"
	"network-service/internal/source"
)

// sourceRouter is a reseller's own User Manager, never touched by us: users
// on their own profiles, one with a limitation, as an import finds them
// (F-1601-a). The router's clock is Tehran's.
func sourceRouter(t *testing.T) (*farEnd, *Driver) {
	t.Helper()
	f, d := open(t)
	f.clockOffset = "+03:30"
	f.put("profile", map[string]string{"name": "monthly-20G", "price": "0", "validity": "30d"})
	f.put("profile", map[string]string{"name": "unlimited", "price": "0", "validity": "unlimited"})
	f.put("limitation", map[string]string{"name": "20G", "transfer-limit": "20G", "rate-limit-rx": "4M", "rate-limit-tx": "4M"})
	f.put("profile-limitation", map[string]string{"profile": "monthly-20G", "limitation": "20G"})
	f.put("user", map[string]string{"name": "ali", "password": "ali-ppp-secret", "comment": "Ali R.", "disabled": "false",
		"total-upload": "1024", "total-download": "4096"})
	f.put("user", map[string]string{"name": "reza", "password": "reza-ppp-secret", "comment": "", "disabled": "true"})
	f.put("user", map[string]string{"name": "sara", "password": "sara-ppp-secret", "comment": "", "disabled": "false"})
	// ali: last month's profile used up, this month's running until a date.
	f.put("user-profile", map[string]string{"user": "ali", "profile": "monthly-20G", "state": "used", "end-time": "2026-10-01 09:00:00"})
	f.put("user-profile", map[string]string{"user": "ali", "profile": "monthly-20G", "state": "running-active", "end-time": "2026-11-01 09:00:00"})
	// reza: a profile bought but not started has no end yet.
	f.put("user-profile", map[string]string{"user": "reza", "profile": "unlimited", "state": "waiting"})
	// sara: an old-format date, from a router before RouterOS 7.10.
	f.put("user-profile", map[string]string{"user": "sara", "profile": "unlimited", "state": "running", "end-time": "nov/15/2026 00:00:00"})
	return f, d
}

// ADR-0160 rule 2: the snapshot reads users, profiles, limits, used bytes,
// expiry and the disabled flag — never a password. The router is never even
// asked for one, so no secret crosses the wire, let alone reaches a run.
func TestASourceSnapshotReadsEveryUserButNeverAPassword(t *testing.T) {
	f, d := sourceRouter(t)

	// Paced, as the snapshot route reads it: the wrapper must not hide the family's in-place read.
	paced := driver.Pace(d, driver.Budget{MaxRequests: source.RequestsPerMinute})
	snap, err := source.Snapshot(context.Background(), paced, source.Limits{})
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	if f.passwordServed {
		t.Fatal("the router was asked for a password")
	}
	raw, _ := json.Marshal(snap)
	if strings.Contains(string(raw), "ppp-secret") {
		t.Fatalf("a password reached the snapshot: %s", raw)
	}

	// A profile is what an import maps to a product (rule 3), where an Xray
	// source lists inbounds.
	var profiles []string
	for _, in := range snap.Inbounds {
		profiles = append(profiles, in.RemoteID)
	}
	if strings.Join(profiles, ",") != "monthly-20G,unlimited" {
		t.Fatalf("inbounds = %v, want the two profiles", profiles)
	}

	by := map[string]source.Client{}
	for _, c := range snap.Clients {
		by[c.RemoteID] = c
	}
	ali, reza, sara := by["ali"], by["reza"], by["sara"]
	tehran := time.FixedZone("+03:30", 3*3600+1800)
	if ali.InboundRemoteID != "monthly-20G" || ali.Label != "Ali R." || !ali.Enabled || ali.UUID != "" {
		t.Errorf("ali = %+v, want the running profile, its comment, enabled, no uuid", ali)
	}
	if ali.DataLimitBytes != 20<<30 || ali.UpBytes != 1024 || ali.DownBytes != 4096 {
		t.Errorf("ali limit %d used %d/%d, want 20 GiB and User Manager's own total 1024/4096",
			ali.DataLimitBytes, ali.UpBytes, ali.DownBytes)
	}
	if want := time.Date(2026, 11, 1, 9, 0, 0, 0, tehran); ali.ExpiresAt == nil || !ali.ExpiresAt.Equal(want) {
		t.Errorf("ali ends %v, want %v: the running profile's end, on the router's clock", ali.ExpiresAt, want)
	}
	if reza.Enabled || reza.InboundRemoteID != "unlimited" || reza.ExpiresAt != nil || reza.DataLimitBytes != 0 {
		t.Errorf("reza = %+v, want disabled, on the waiting profile, no end, no limit", reza)
	}
	if want := time.Date(2026, 11, 15, 0, 0, 0, 0, tehran); sara.ExpiresAt == nil || !sara.ExpiresAt.Equal(want) {
		t.Errorf("sara ends %v, want %v from the pre-7.10 date format", sara.ExpiresAt, want)
	}
}

// An end the router writes in a shape we cannot read fails the snapshot
// rather than importing the user with no end (contract.import.md rule 1).
func TestAnUnreadableEndFailsTheSnapshot(t *testing.T) {
	f, d := sourceRouter(t)
	f.put("user", map[string]string{"name": "omid", "comment": "", "disabled": "false"})
	f.put("user-profile", map[string]string{"user": "omid", "profile": "unlimited", "state": "running", "end-time": "soon"})
	if _, err := source.Snapshot(context.Background(), d, source.Limits{}); err == nil {
		t.Fatal("an unreadable end-time was read as no end")
	}
}

// A profile of unlimited validity has the end-time `unlimited` — what a
// v7.24 CHR writes for it (F-1601-e) — and its user has no end.
func TestAnUnlimitedProfileHasNoEnd(t *testing.T) {
	f, d := sourceRouter(t)
	f.put("user", map[string]string{"name": "omid", "comment": "", "disabled": "false"})
	f.put("user-profile", map[string]string{"user": "omid", "profile": "unlimited", "state": "running", "end-time": "unlimited"})
	accounts, err := d.ListAccounts(context.Background())
	if err != nil {
		t.Fatalf("ListAccounts: %v", err)
	}
	for _, a := range accounts {
		if a.RemoteID == "omid" && (!a.ExpiresAt.IsZero() || a.InboundRemoteID != "unlimited") {
			t.Fatalf("read %+v, want omid on profile unlimited with no end", a)
		}
	}
}

// contract.source.md rule 1: every family an import reads proves its reads
// change nothing on the reseller's live router.
func TestReadingASourceWritesNothing(t *testing.T) {
	conformance.RunReadOnly(t, func(t *testing.T, shape conformance.Shape) (conformance.Harness, bool) {
		if shape.Transport != driver.TransportPush || !shape.GigawordsReported {
			return nil, false
		}
		f, d := open(t)
		return &harness{f: f, d: d}, true
	})
}
