package marzban

import (
	"context"
	"net/http"
	"testing"
)

// F-027-fl (user 2026-10-28, LIVE-1): Marzban 0.8.4's remove_user commits the
// delete, then raises building its notification for a user with no owner
// admin (every user the env sudo admin made through the API) and answers 500.
// FastAPI then never runs the request's background tasks — Xray's
// remove_user among them — so the client went on serving in Xray, unread by
// us. The driver disables first (modify_user's Xray path works) and reads a
// 500 back.

// deleteScript is how the far end answers a DELETE: normally, deleting and then
// answering 500 (0.8.4), or answering 500 without deleting. It records the
// status each user had when its delete arrived.
type deleteScript struct {
	landThen500 bool
	fail500     bool
	statusAt    map[string]string
}

// refuse records the user's status and, for fail500, answers without deleting.
func (s *deleteScript) refuse(w http.ResponseWriter, u *farUser) bool {
	if s.statusAt == nil {
		s.statusAt = map[string]string{}
	}
	s.statusAt[u.Username] = u.Status
	if s.fail500 {
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return true
	}
	return false
}

func seedUser(f *farEnd, name string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.users[name] = &farUser{Username: name, UUID: "uuid-" + name, Protocol: "vless", Inbound: "VLESS TCP", Status: "active"}
	f.order = append(f.order, name)
}

func TestADeleteDisablesTheUserFirstSoXrayDropsIt(t *testing.T) {
	f, d := open(t)
	seedUser(f, "u1")

	if err := d.DeleteClient(context.Background(), "u1"); err != nil {
		t.Fatalf("DeleteClient: %v", err)
	}
	if got := f.deletes.statusAt["u1"]; got != "disabled" {
		t.Fatalf("the user was %q when its delete arrived, want disabled", got)
	}
	if _, ok := f.users["u1"]; ok {
		t.Fatal("the user is still on the panel")
	}
}

func TestADeleteThatLandedBehindA500IsADelete(t *testing.T) {
	f, d := open(t)
	seedUser(f, "u1")
	f.deletes.landThen500 = true

	if err := d.DeleteClient(context.Background(), "u1"); err != nil {
		t.Fatalf("DeleteClient = %v, want nil: the user is gone", err)
	}
}

func TestA500OnADeleteThatDidNotLandIsAFailure(t *testing.T) {
	f, d := open(t)
	seedUser(f, "u1")
	f.deletes.fail500 = true

	if err := d.DeleteClient(context.Background(), "u1"); err == nil {
		t.Fatal("DeleteClient = nil, want the 500: the user is still there")
	}
}

func TestDeletingAUserAlreadyGoneIsDone(t *testing.T) {
	_, d := open(t)
	if err := d.DeleteClient(context.Background(), "nobody"); err != nil {
		t.Fatalf("DeleteClient = %v, want nil: a user not there is deleted", err)
	}
}
