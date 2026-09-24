package opener

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"network-service/internal/driver"
	"network-service/internal/driver/hiddify"
	"network-service/internal/driver/marzban"
	"network-service/internal/driver/sanaee"
	"network-service/internal/driver/threexui"
	"network-service/internal/driver/usermanager"
	"network-service/internal/driver/xuialireza"
	"network-service/internal/register"
)

const panelID = "55555555-5555-4555-8555-555555555555"

// vaultStub is tenant-service's use route: the service token, the panel id,
// and an answer or a refusal. asked records which secret each call named.
func vaultStub(t *testing.T, login string, status int, reason string) (*httptest.Server, *int) {
	srv, calls, _ := vaultStubAsked(t, login, status, reason)
	return srv, calls
}

func vaultStubAsked(t *testing.T, login string, status int, reason string) (*httptest.Server, *int, *[]string) {
	t.Helper()
	calls := 0
	var asked []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Method != http.MethodPost || r.URL.Path != usePath {
			t.Errorf("vault asked %s %s, want POST %s", r.Method, r.URL.Path, usePath)
		}
		if r.Header.Get(ServiceTokenHeader) != "svc-token" {
			http.NotFound(w, r)
			return
		}
		var body struct {
			PanelID string
			Secret  string
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		asked = append(asked, body.Secret)
		if body.PanelID != panelID {
			t.Errorf("vault asked for panel %q, want %q", body.PanelID, panelID)
		}
		if status != http.StatusOK {
			w.WriteHeader(status)
			_ = json.NewEncoder(w).Encode(map[string]string{"reason": reason, "message": reason})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"credentials": login})
	}))
	t.Cleanup(srv.Close)
	return srv, &calls, &asked
}

func pending(family driver.DriverType) register.Pending {
	return register.Pending{
		PanelID: panelID, DriverType: family, Transport: driver.TransportPull,
		CounterSemantics: driver.CounterCumulative, APIBaseURL: "https://panel.example:8000",
		Credentials: "vault:22222222-2222-4222-8222-222222222222:panel_credentials:panel:" + panelID,
	}
}

func TestOpensMarzbanWithTheVaultsLogin(t *testing.T) {
	srv, _ := vaultStub(t, "admin:pa:ss", http.StatusOK, "")
	o := Opener{Logins: Vault{BaseURL: srv.URL + "/", ServiceToken: "svc-token"}}

	d, err := o.Open(context.Background(), pending(driver.DriverMarzban))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if _, ok := d.(*marzban.Driver); !ok {
		t.Fatalf("Open built %T, want *marzban.Driver", d)
	}
}

// A 3x-ui panel signs in with the same username:password login, and its
// base URL keeps the panel's secret web path (F-027-ah).
func TestOpensSanaeeWithTheVaultsLogin(t *testing.T) {
	srv, _ := vaultStub(t, "admin:pa:ss", http.StatusOK, "")
	o := Opener{Logins: Vault{BaseURL: srv.URL, ServiceToken: "svc-token"}}

	p := pending(driver.DriverSanaee)
	p.APIBaseURL = "https://panel.example:2053/s3cr3t-path"
	d, err := o.Open(context.Background(), p)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if _, ok := d.(*sanaee.Driver); !ok {
		t.Fatalf("Open built %T, want *sanaee.Driver", d)
	}
}

// 3x-ui v3 is its own family, not v2's (F-027-bb): the same username:password
// login opens the v3 driver, never the sanaee one, whose routes v3 removed.
func TestOpensThreeXUIWithItsOwnDriverNotSanaees(t *testing.T) {
	srv, _ := vaultStub(t, "admin:pa:ss", http.StatusOK, "")
	o := Opener{Logins: Vault{BaseURL: srv.URL, ServiceToken: "svc-token"}}

	p := pending(driver.DriverThreeXUI)
	p.APIBaseURL = "https://panel.example:2053/s3cr3t-path"
	d, err := o.Open(context.Background(), p)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if _, ok := d.(*threexui.Driver); !ok {
		t.Fatalf("Open built %T, want *threexui.Driver", d)
	}
}

// The two x-ui forks are two families (F-027-bc): `x_ui_alireza` opens the
// driver over the fork's /xui/API, and the original's `x_ui_vaxilu`, which has
// no such API, is not opened by it.
func TestOpensXUIAlirezaButNotTheOriginalWithIt(t *testing.T) {
	srv, _ := vaultStub(t, "admin:pa:ss", http.StatusOK, "")
	o := Opener{Logins: Vault{BaseURL: srv.URL, ServiceToken: "svc-token"}}

	p := pending(driver.DriverXUIAlireza)
	p.APIBaseURL = "https://panel.example:54321"
	d, err := o.Open(context.Background(), p)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if _, ok := d.(*xuialireza.Driver); !ok {
		t.Fatalf("Open built %T, want *xuialireza.Driver", d)
	}
	if _, err := o.Open(context.Background(), pending(driver.DriverXUIVaxilu)); !errors.Is(err, ErrNoDriver) {
		t.Fatalf("Open(x_ui_vaxilu) = %v, want ErrNoDriver until F-027-bd", err)
	}
}

// Hiddify's login is its API key alone: no username:password split, which a
// uuid would fail.
func TestOpensHiddifyWithTheKeyAlone(t *testing.T) {
	srv, _ := vaultStub(t, "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0", http.StatusOK, "")
	o := Opener{Logins: Vault{BaseURL: srv.URL, ServiceToken: "svc-token"}}

	p := pending(driver.DriverHiddify)
	p.APIBaseURL = "https://panel.example/adm1n"
	d, err := o.Open(context.Background(), p)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if _, ok := d.(*hiddify.Driver); !ok {
		t.Fatalf("Open built %T, want *hiddify.Driver", d)
	}
}

// A push panel has two secrets (F-027-az). The Opener signs in to the
// router's REST API, so it asks for the login by name; the NAS secret is the
// allowlist's, and a driver built with it would be refused on every call.
func TestOpensUserManagerWithItsRESTLoginNotItsRadiusSecret(t *testing.T) {
	srv, _, asked := vaultStubAsked(t, "api:pa:ss", http.StatusOK, "")
	o := Opener{Logins: Vault{BaseURL: srv.URL, ServiceToken: "svc-token"}}

	p := pending(driver.DriverMikrotikUserManager)
	p.Transport, p.CounterSemantics, p.APIBaseURL = driver.TransportPush, driver.CounterSession, "https://10.0.0.1"
	d, err := o.Open(context.Background(), p)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if _, ok := d.(*usermanager.Driver); !ok {
		t.Fatalf("Open built %T, want *usermanager.Driver", d)
	}
	if len(*asked) != 1 || (*asked)[0] != "login" {
		t.Errorf("the Opener asked the vault for %q, want exactly [login]", *asked)
	}
}

// The allowlist's read names the secret, and the vault's answer comes back
// in the same field as a login does.
func TestTheRadiusSecretIsAskedForByName(t *testing.T) {
	srv, _, asked := vaultStubAsked(t, "nas-shared", http.StatusOK, "")
	got, err := Vault{BaseURL: srv.URL, ServiceToken: "svc-token"}.PanelRadiusSecret(context.Background(), panelID)
	if err != nil || got != "nas-shared" {
		t.Fatalf("PanelRadiusSecret = %q, %v", got, err)
	}
	if len(*asked) != 1 || (*asked)[0] != "radius_secret" {
		t.Errorf("the vault was asked for %q, want exactly [radius_secret]", *asked)
	}
}

// A family with no driver is ours to ship, not the panel's fault: it stays
// pending and costs no read of its login.
func TestAFamilyWithNoDriverIsNotOpenedAndItsLoginNotRead(t *testing.T) {
	srv, calls := vaultStub(t, "admin:secret", http.StatusOK, "")
	o := Opener{Logins: Vault{BaseURL: srv.URL, ServiceToken: "svc-token"}}

	_, err := o.Open(context.Background(), pending(driver.DriverSUI))
	if !errors.Is(err, ErrNoDriver) {
		t.Fatalf("Open(s_ui) = %v, want ErrNoDriver", err)
	}
	if *calls != 0 {
		t.Errorf("the vault was read %d times for a panel nothing could open", *calls)
	}
	if kind, ok := driver.KindOf(err); ok {
		t.Errorf("the error classifies as %s: it must fall through to unopenable, not read as a panel fault", kind)
	}
}

func TestALoginNotInTheFormIsRefusedWithoutQuotingIt(t *testing.T) {
	srv, _ := vaultStub(t, "hunter2-without-a-colon", http.StatusOK, "")
	o := Opener{Logins: Vault{BaseURL: srv.URL, ServiceToken: "svc-token"}}

	_, err := o.Open(context.Background(), pending(driver.DriverMarzban))
	if err == nil {
		t.Fatal("Open accepted a login with no username:password split")
	}
	if strings.Contains(err.Error(), "hunter2") {
		t.Errorf("the error %q quotes the login, and it is written to connectionTestDetail", err)
	}
}

func TestAVaultRefusalNamesItsReason(t *testing.T) {
	srv, _ := vaultStub(t, "", http.StatusForbidden, "not_owner")
	o := Opener{Logins: Vault{BaseURL: srv.URL, ServiceToken: "svc-token"}}

	_, err := o.Open(context.Background(), pending(driver.DriverMarzban))
	if err == nil || !strings.Contains(err.Error(), "not_owner") {
		t.Fatalf("Open = %v, want the vault's reason not_owner in it", err)
	}
}

// The header name crosses a process boundary, so it is held to
// contracts/http/wire.json as every other reader of it is (ADR-0036).
func TestServiceTokenHeaderIsTheWireContracts(t *testing.T) {
	raw, err := os.ReadFile(filepath.Clean("../../../contracts/http/wire.json"))
	if err != nil {
		t.Fatalf("reading wire.json: %v", err)
	}
	var wire struct {
		RequestHeaders map[string]string `json:"requestHeaders"`
	}
	if err := json.Unmarshal(raw, &wire); err != nil {
		t.Fatalf("parsing wire.json: %v", err)
	}
	if got := wire.RequestHeaders["serviceToken"]; got != ServiceTokenHeader {
		t.Errorf("ServiceTokenHeader = %q, wire.json says %q", ServiceTokenHeader, got)
	}
}
