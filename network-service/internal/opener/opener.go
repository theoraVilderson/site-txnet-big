// Package opener builds a real driver from a panel row (F-027-aw): the
// register.Opener the registrar was written against, and the one the panel
// source will share.
//
// The login is not in the row. `panelApiCredentials` is a vault reference,
// the vault is Node with a data key per tenant, and this service never holds
// the KEK (user, 2026-09-24). So the login is read through `tenant-service`'s
// service-only `POST /api/internal/vault/panel-credential/use`, which
// re-derives the owner's vault from the panel row and logs the read — one
// crypto implementation, every use audited where the others are.
package opener

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"network-service/internal/driver"
	"network-service/internal/driver/marzban"
	"network-service/internal/register"
)

// ServiceTokenHeader is `requestHeaders.serviceToken` in
// contracts/http/wire.json (ADR-0036); opener_test.go holds it to the file.
const ServiceTokenHeader = "x-service-token"

// usePath is the route in tenant-service's vault module that answers a
// panel's login (`contract.vault.md`, internal routes).
const usePath = "/api/internal/vault/panel-credential/use"

// LoginSource answers a panel's login in plaintext. The Opener holds it for
// the length of one Open and nowhere else.
type LoginSource interface {
	PanelLogin(ctx context.Context, panelID string) (string, error)
}

// Vault is the LoginSource over tenant-service.
type Vault struct {
	BaseURL      string
	ServiceToken string
	HTTP         *http.Client
}

// PanelLogin asks tenant-service for the login. A refusal names its reason
// (`panel_not_found`, `not_owner`, `credential_unavailable`) and never a
// value; the registrar records it as `unopenable`, and the panel stays pending.
func (v Vault) PanelLogin(ctx context.Context, panelID string) (string, error) {
	body, _ := json.Marshal(map[string]string{"panelId": panelID})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(v.BaseURL, "/")+usePath, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(ServiceTokenHeader, v.ServiceToken)
	client := v.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("vault unreachable: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		var refusal struct {
			Reason string `json:"reason"`
		}
		_ = json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&refusal)
		if refusal.Reason == "" {
			refusal.Reason = "no reason given"
		}
		return "", fmt.Errorf("vault refused the login read (http %d): %s", resp.StatusCode, refusal.Reason)
	}
	var answer struct {
		Credentials string `json:"credentials"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&answer); err != nil || answer.Credentials == "" {
		return "", errors.New("vault answered no login")
	}
	return answer.Credentials, nil
}

// Opener is register.Opener over the families this service has drivers for.
type Opener struct {
	Logins LoginSource
	// HTTP is the client every driver it builds speaks through. Nil is a
	// client with no timeout of its own: each call's context is the deadline.
	HTTP *http.Client
}

var _ register.Opener = Opener{}

// ErrNoDriver is a family with no driver yet. The panel stays pending,
// `unopenable`, until one ships — never refused for a gap that is ours.
var ErrNoDriver = errors.New("no driver for this family yet")

// Open builds the family's driver. The family is checked before the vault is
// asked, so a panel no driver can open costs no read of its login.
func (o Opener) Open(ctx context.Context, p register.Pending) (driver.Driver, error) {
	switch p.DriverType {
	case driver.DriverMarzban:
	default:
		return nil, fmt.Errorf("%w: %q", ErrNoDriver, p.DriverType)
	}
	if p.APIBaseURL == "" {
		return nil, errors.New("panel has no apiBaseUrl")
	}
	login, err := o.Logins.PanelLogin(ctx, p.PanelID)
	if err != nil {
		return nil, err
	}
	creds, err := usernamePassword(login)
	if err != nil {
		return nil, err
	}
	return marzban.New(p.APIBaseURL, creds, o.HTTP)
}

// usernamePassword reads a login typed as `username:password`, split at the
// first colon: a username cannot hold one on these panels, and a password
// can. Its error never quotes the login.
func usernamePassword(login string) (marzban.Credentials, error) {
	username, password, ok := strings.Cut(strings.TrimSpace(login), ":")
	if !ok || username == "" || password == "" {
		return marzban.Credentials{}, errors.New("the stored login is not in the form username:password")
	}
	return marzban.Credentials{Username: username, Password: password}, nil
}
