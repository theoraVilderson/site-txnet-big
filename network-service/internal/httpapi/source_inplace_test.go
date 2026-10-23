package httpapi

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"testing"

	"network-service/internal/driver"
	"network-service/internal/driver/fake"
	"network-service/internal/egress"
	"network-service/internal/register"
	"network-service/internal/source"
)

// panels is the tenant's registered panels as the in-place read opens them.
type panels struct {
	asked []string
	err   error
}

func (p *panels) OpenInPlace(_ context.Context, tenantID, panelID string, family driver.DriverType) (driver.Driver, error) {
	p.asked = append(p.asked, fmt.Sprintf("%s/%s/%s", tenantID, panelID, family))
	if p.err != nil {
		return nil, p.err
	}
	d := fake.New(fake.Config{Transport: driver.TransportPush, CounterSemantics: driver.CounterSession})
	d.Given("ali")
	return d, nil
}

func inPlaceServer(p *panels) *http.ServeMux {
	mux := http.NewServeMux()
	// The vault refuses every read: a run read in place never asks it for a source login.
	(&Source{Logins: logins{err: errors.New("no source login for an in-place run")}, Panels: p,
		HTTP: source.HTTPClient(egress.Guard{}), ServiceToken: "tok",
		Log: slog.New(slog.NewTextHandler(io.Discard, nil))}).Register(mux)
	return mux
}

// F-1601-b1 (ADR-0160): a User Manager run names the tenant's registered
// panel, and the snapshot is read with that panel's own login — never a
// source login, and never a panel of another tenant or family.
func TestASnapshotInPlaceOpensTheTenantsRegisteredPanel(t *testing.T) {
	p := &panels{}
	code, reason := post(inPlaceServer(p), "tok", `{"tenantId":"t1","family":"mikrotik_user_manager","panelId":"p1"}`)
	if code != http.StatusOK {
		t.Fatalf("%d %s, want 200", code, reason)
	}
	if len(p.asked) != 1 || p.asked[0] != "t1/p1/mikrotik_user_manager" {
		t.Fatalf("opened %v, want the tenant's panel p1 of the family", p.asked)
	}
}

func TestASnapshotInPlaceRefusesWhatItCannotOpen(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		err        error
		code       int
		reason     string
	}{
		{"a family read through a login", `{"tenantId":"t1","family":"marzban","panelId":"p1"}`, nil, http.StatusBadRequest, "bad_request"},
		{"both a login and a panel", `{"tenantId":"t1","family":"mikrotik_user_manager","panelId":"p1","credentialRef":"r"}`, nil, http.StatusBadRequest, "bad_request"},
		{"an in-place family by its login", `{"tenantId":"t1","family":"mikrotik_user_manager","credentialRef":"r"}`, nil, http.StatusBadRequest, "bad_request"},
		{"not the tenant's accepted panel", `{"tenantId":"t1","family":"mikrotik_user_manager","panelId":"p1"}`, register.ErrNoInPlacePanel, http.StatusUnprocessableEntity, "panel_not_found"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			code, reason := post(inPlaceServer(&panels{err: tc.err}), "tok", tc.body)
			if code != tc.code || reason != tc.reason {
				t.Fatalf("%d %s, want %d %s", code, reason, tc.code, tc.reason)
			}
		})
	}
}
