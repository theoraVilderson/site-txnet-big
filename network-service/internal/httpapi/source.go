package httpapi

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"time"

	"network-service/internal/driver"
	"network-service/internal/egress"
	"network-service/internal/opener"
	"network-service/internal/source"
)

// The three internal routes an import reads a source through (F-201-b,
// network contract.source.md). Service-only: never routed by Traefik, and
// each request carries the service token.
const (
	SourceSnapshotPath = "POST /api/internal/source/snapshot"
	SourceLinksPath    = "POST /api/internal/source/links"
	SourceLinkPath     = "POST /api/internal/source/link"
)

// How long each route may read its source. A snapshot is a few bulk calls; a
// link batch is up to 400 paced requests (source.MaxLinkBatch).
const (
	snapshotDeadline = 2 * time.Minute
	linksDeadline    = 3 * time.Minute
	linkDeadline     = source.RequestTimeout
	// maxRequestBody bounds what a caller may send: a link batch is the
	// largest, 200 clients of a few ids each.
	maxRequestBody = 1 << 20
)

// SourceLogins reads an import's source address and login from the vault by
// the run's credential reference (opener.Vault).
type SourceLogins interface {
	SourceLogin(ctx context.Context, tenantID, credentialRef string) (opener.SourcePanel, error)
}

// Source serves the source routes.
type Source struct {
	Logins SourceLogins
	// HTTP is the client a source is dialed through: source.HTTPClient over
	// the bare guard.
	HTTP *http.Client
	// ServiceToken is what each request must carry; empty refuses every one.
	ServiceToken string
	Log          *slog.Logger
}

// Register mounts the three routes on mux.
func (s *Source) Register(mux *http.ServeMux) {
	mux.HandleFunc(SourceSnapshotPath, s.serviceOnly(s.snapshot))
	mux.HandleFunc(SourceLinksPath, s.serviceOnly(s.links))
	mux.HandleFunc(SourceLinkPath, s.serviceOnly(s.link))
}

func (s *Source) serviceOnly(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		got := r.Header.Get(opener.ServiceTokenHeader)
		if s.ServiceToken == "" || subtle.ConstantTimeCompare([]byte(got), []byte(s.ServiceToken)) != 1 {
			refuse(w, http.StatusForbidden, "service_only", "")
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, maxRequestBody)
		next(w, r)
	}
}

// panelRequest names a source panel: whose run, which family, and the vault
// reference its address and login are sealed under (F-201-d) — never the
// address itself, which is as secret as the login.
type panelRequest struct {
	TenantID      string            `json:"tenantId"`
	Family        driver.DriverType `json:"family"`
	CredentialRef string            `json:"credentialRef"`
}

func (p panelRequest) valid() bool {
	return p.TenantID != "" && p.CredentialRef != "" && source.IsFamily(p.Family)
}

func absolute(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && (u.Scheme == "https" || u.Scheme == "http") && u.Host != ""
}

func (s *Source) snapshot(w http.ResponseWriter, r *http.Request) {
	var req panelRequest
	if !decode(r.Body, &req) || !req.valid() {
		refuse(w, http.StatusBadRequest, "bad_request", "")
		return
	}
	ctx, cancel := s.deadline(w, r, snapshotDeadline)
	defer cancel()
	reader, err := s.open(ctx, req)
	if err == nil {
		var snap source.Panel
		if snap, err = source.Snapshot(ctx, reader, source.Limits{}); err == nil {
			s.Log.Info("source snapshot read", "tenant", req.TenantID, "family", req.Family, "clients", len(snap.Clients))
			answer(w, snap)
			return
		}
	}
	s.fail(w, req, err)
}

func (s *Source) links(w http.ResponseWriter, r *http.Request) {
	var req struct {
		panelRequest
		Clients []source.LinkRequest `json:"clients"`
	}
	if !decode(r.Body, &req) || !req.valid() || len(req.Clients) == 0 {
		refuse(w, http.StatusBadRequest, "bad_request", "")
		return
	}
	ctx, cancel := s.deadline(w, r, linksDeadline)
	defer cancel()
	reader, err := s.open(ctx, req.panelRequest)
	if err == nil {
		var got []source.ClientLinks
		if got, err = source.Links(ctx, reader, req.Clients); err == nil {
			answer(w, map[string]any{"clients": got})
			return
		}
	}
	s.fail(w, req.panelRequest, err)
}

func (s *Source) link(w http.ResponseWriter, r *http.Request) {
	var req struct {
		URL string `json:"url"`
	}
	if !decode(r.Body, &req) || !absolute(req.URL) {
		refuse(w, http.StatusBadRequest, "bad_request", "")
		return
	}
	ctx, cancel := s.deadline(w, r, linkDeadline)
	defer cancel()
	got, err := source.FetchLink(ctx, s.HTTP, req.URL)
	if err != nil {
		reason, status := reasonOf(err)
		s.Log.Warn("source link read refused", "reason", reason, "error", err)
		refuse(w, status, reason, err.Error())
		return
	}
	answer(w, got)
}

// open reads the login and builds the family's driver, paced: the source is
// a reseller's live panel (source.RequestsPerMinute).
func (s *Source) open(ctx context.Context, req panelRequest) (source.Reader, error) {
	panel, err := s.Logins.SourceLogin(ctx, req.TenantID, req.CredentialRef)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errCredential, err)
	}
	if !absolute(panel.APIBaseURL) || (panel.ClientBaseURL != "" && !absolute(panel.ClientBaseURL)) {
		return nil, fmt.Errorf("%w: the stored address is not an absolute http(s) url", errCredential)
	}
	d, err := opener.Build(opener.Target{Family: req.Family, APIBaseURL: panel.APIBaseURL, ClientBaseURL: panel.ClientBaseURL}, panel.Login, s.HTTP)
	if err != nil {
		return nil, err
	}
	return driver.Pace(d, driver.Budget{MaxRequests: source.RequestsPerMinute}), nil
}

// deadline lifts the server's write timeout for this response alone and
// bounds the read by d.
func (s *Source) deadline(w http.ResponseWriter, r *http.Request, d time.Duration) (context.Context, context.CancelFunc) {
	if err := http.NewResponseController(w).SetWriteDeadline(time.Now().Add(d + 5*time.Second)); err != nil {
		s.Log.Warn("source route could not extend its write deadline", "error", err)
	}
	return context.WithTimeout(r.Context(), d)
}

func (s *Source) fail(w http.ResponseWriter, req panelRequest, err error) {
	reason, status := reasonOf(err)
	s.Log.Warn("source read refused", "tenant", req.TenantID, "family", req.Family, "reason", reason, "error", err)
	refuse(w, status, reason, err.Error())
}

var errCredential = errors.New("source login unavailable")

// reasonOf names a failure for the caller. The order matters: the guard's and
// the caps' errors arrive wrapped in a driver Fault, and say more than its kind.
func reasonOf(err error) (string, int) {
	var fault *driver.Fault
	switch {
	case errors.Is(err, errCredential):
		return "credential_unavailable", http.StatusUnprocessableEntity
	case errors.Is(err, opener.ErrNoDriver):
		return "no_driver", http.StatusUnprocessableEntity
	case errors.Is(err, egress.ErrRefused):
		return "address_refused", http.StatusUnprocessableEntity
	case errors.Is(err, source.ErrRedirect):
		return "source_redirected", http.StatusUnprocessableEntity
	case errors.Is(err, source.ErrTooManyClients), errors.Is(err, egress.ErrBodyTooLarge):
		return "source_too_large", http.StatusUnprocessableEntity
	case errors.Is(err, source.ErrBatchTooLarge):
		return "bad_request", http.StatusBadRequest
	case errors.As(err, &fault) && fault.Kind == driver.FaultBlocked:
		return "source_login_refused", http.StatusUnprocessableEntity
	case errors.As(err, &fault) && (fault.Kind == driver.FaultProtocol || fault.Kind == driver.FaultUnsupported):
		return "source_unreadable", http.StatusBadGateway
	case errors.As(err, &fault):
		return "source_unavailable", http.StatusBadGateway
	}
	// A login not in the family's form (opener.Build) is the reseller's to fix.
	return "login_malformed", http.StatusUnprocessableEntity
}

func decode(body io.Reader, into any) bool {
	return json.NewDecoder(body).Decode(into) == nil
}

// answer and refuse speak the shared envelope: `data`, or `error.reason`. An
// encode error is a caller that hung up; there is no one left to tell.
func answer(w http.ResponseWriter, data any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"data": data})
}

func refuse(w http.ResponseWriter, status int, reason, detail string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"reason": reason, "detail": detail}})
}
