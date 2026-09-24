// Package httpapi serves this service's health endpoint
// for the container. It is not routed through the gateway: only `/sub/` is.
package httpapi

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"
)

// Pinger is the database as this endpoint needs to see it.
type Pinger interface {
	Ping(ctx context.Context) error
}

// Handler serves the health endpoint.
type Handler struct {
	db      Pinger
	log     *slog.Logger
	timeout time.Duration
}

// New builds the handler. The ping timeout is short on purpose: a health
// check that waits on a hung database reads as a hung service.
func New(db Pinger, log *slog.Logger) *Handler {
	return &Handler{db: db, log: log, timeout: 2 * time.Second}
}

// WithPingTimeout overrides how long the database has to answer.
func (h *Handler) WithPingTimeout(d time.Duration) *Handler {
	h.timeout = d
	return h
}

type healthResponse struct {
	Status string            `json:"status"`
	Checks map[string]string `json:"checks"`
}

// Health reports whether this process can still reach its database.
func (h *Handler) Health(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), h.timeout)
	defer cancel()

	body := healthResponse{Status: "ok", Checks: map[string]string{"database": "ok"}}
	status := http.StatusOK
	if err := h.db.Ping(ctx); err != nil {
		body = healthResponse{Status: "degraded", Checks: map[string]string{"database": "unreachable"}}
		status = http.StatusServiceUnavailable
		h.log.Warn("health check failed", "error", err)
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		h.log.Error("writing health response failed", "error", err)
	}
}
