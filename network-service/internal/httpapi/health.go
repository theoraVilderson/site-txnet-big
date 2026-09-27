// Package httpapi serves this service's only HTTP surface: a health endpoint
// for the container and the external watchdog, and `/metrics` for Prometheus
// on the private network (F-027-dm). Nothing here answers a user request, and
// nothing here is routed through the gateway (ADR-0071).
package httpapi

import (
	"context"
	"encoding/json"
	"io"
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

// Health reports whether this process can still reach its database. It is a
// liveness answer, not a collection-health one — whether the collection loop
// is still making progress is `panel.lastSuccessfulCollectionAt`, which the
// external watchdog reads directly (F-027-w).
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

// Metrics serves what src writes, as the Prometheus text format. A failed
// write is the scraper gone; it is logged, and there is no status left to set.
func (h *Handler) Metrics(src io.WriterTo) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		if _, err := src.WriteTo(w); err != nil {
			h.log.Warn("writing metrics failed", "error", err)
		}
	}
}
