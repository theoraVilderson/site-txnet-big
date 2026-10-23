package usermanager

import (
	"context"
	"testing"

	"network-service/internal/driver"
)

// adoptable is a reseller's router with one user on its own profile, as an
// import in place finds it (F-1601-b2).
func adoptable(t *testing.T) (*farEnd, *Driver) {
	t.Helper()
	f, d := open(t)
	f.put("profile", map[string]string{"name": "monthly-20G", "price": "0", "validity": "30d"})
	f.put("limitation", map[string]string{"name": "20G", "transfer-limit": "20G"})
	f.put("profile-limitation", map[string]string{"profile": "monthly-20G", "limitation": "20G"})
	f.put("user", map[string]string{"name": "ali", "password": "ali-ppp-secret", "comment": "Ali R.", "disabled": "false"})
	f.put("user-profile", map[string]string{"user": "ali", "profile": "monthly-20G", "state": "running-active"})
	return f, d
}

func (f *farEnd) profilesOf(user string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, l := range f.tables["user-profile"] {
		if l["user"] == user {
			out = append(out, l["profile"])
		}
	}
	return out
}

// Adoption puts the user under our chain alone — its own profile detached, or
// User Manager would grant the more permissive of the two — with our claim
// tag as the mark it is done, and never writes the password the customer's
// device logs in with (ADR-0160 rule 2).
func TestAdoptionTakesTheUserOverWithoutItsPassword(t *testing.T) {
	f, d := adoptable(t)
	req := driver.AdoptRequest{RemoteID: "ali", ClaimTag: "txn-ali", DataLimitBytes: 5 << 30, RateLimitBps: 2_000_000, Enabled: true}
	for range 2 { // a repeat finishes or confirms, never fails on its own rows
		if err := d.AdoptClient(context.Background(), req); err != nil {
			t.Fatalf("AdoptClient: %v", err)
		}
	}
	if got := f.profilesOf("ali"); len(got) != 1 || got[0] != "txnet-ali" {
		t.Fatalf("ali holds %v, want our chain alone", got)
	}
	if lim := f.row("limitation", "txnet-ali"); lim == nil || lim["transfer-limit"] != "5368709120" {
		t.Fatalf("our limitation is %v, want the first ceiling", lim)
	}
	u := f.row("user", "ali")
	if u["comment"] != "txn-ali" || u["password"] != "ali-ppp-secret" || f.passwordWritten {
		t.Fatalf("ali is %v (password written: %v), want our tag and its own password untouched", u, f.passwordWritten)
	}
}

// A hand back links the user's own profile again before ours comes off, puts
// its comment back, and never deletes the user (ADR-0160 decision 7).
func TestAHandBackRestoresTheUserAsImported(t *testing.T) {
	f, d := adoptable(t)
	ctx := context.Background()
	if err := d.AdoptClient(ctx, driver.AdoptRequest{RemoteID: "ali", ClaimTag: "txn-ali", DataLimitBytes: 1 << 30, Enabled: true}); err != nil {
		t.Fatalf("AdoptClient: %v", err)
	}
	back := driver.ReleaseRequest{RemoteID: "ali", Profile: "monthly-20G", Label: "Ali R."}
	for range 2 {
		if err := d.ReleaseClient(ctx, back); err != nil {
			t.Fatalf("ReleaseClient: %v", err)
		}
	}
	if got := f.profilesOf("ali"); len(got) != 1 || got[0] != "monthly-20G" {
		t.Fatalf("ali holds %v, want its own profile alone", got)
	}
	for _, menu := range []string{"profile", "limitation"} {
		if f.row(menu, "txnet-ali") != nil {
			t.Errorf("our %s is still on the router", menu)
		}
	}
	if u := f.row("user", "ali"); u == nil || u["comment"] != "Ali R." || f.passwordWritten {
		t.Fatalf("ali is %v, want it kept, its comment back and its password untouched", u)
	}
}

// A hand back whose profile the reseller has since deleted keeps our chain on:
// taking it off would leave a user no profile, which logs nobody in.
func TestAHandBackToAProfileGoneKeepsOurs(t *testing.T) {
	f, d := adoptable(t)
	ctx := context.Background()
	if err := d.AdoptClient(ctx, driver.AdoptRequest{RemoteID: "ali", ClaimTag: "txn-ali", DataLimitBytes: 1 << 30, Enabled: true}); err != nil {
		t.Fatalf("AdoptClient: %v", err)
	}
	if err := d.ReleaseClient(ctx, driver.ReleaseRequest{RemoteID: "ali", Profile: "deleted-meanwhile"}); err == nil {
		t.Fatal("a hand back to a profile that is gone succeeded")
	}
	if got := f.profilesOf("ali"); len(got) != 1 || got[0] != "txnet-ali" {
		t.Fatalf("ali holds %v, want our chain still on", got)
	}
}
