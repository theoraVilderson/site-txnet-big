// Package invalidate turns Postgres's `sub_invalidate` notifications into the
// stamps the render cache is judged by (F-113-c, ADR-0083).
//
// The triggers (migration `20260924000700_sub_is_told_what_changed`) NOTIFY on
// every write that can change a render: a panel's state, a config of a Grant
// or the Grant itself, a tenant's domain. This process holds one `LISTEN`
// connection and, for each notification, writes the Redis time into
// `sub:changed:<kind>:<id>`. A cached render built before that time is not
// served again.
package invalidate

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"

	"sub-service/internal/cache"
	"sub-service/internal/db"
)

// Channel is the channel the triggers notify on.
const Channel = "sub_invalidate"

// Stamps is the Redis the listener writes.
type Stamps interface {
	Now(ctx context.Context) (int64, error)
	Set(ctx context.Context, key string, value []byte, ttl time.Duration) error
}

// Listener holds the `LISTEN` connection.
type Listener struct {
	databaseURL    string
	connectTimeout time.Duration
	stamps         Stamps
	prefix         string
	// keep is how long a stamp outlives the entries it can outdate: an entry
	// lives one TTL from after its build began, and a stamp that expired
	// before it would read as "never changed".
	keep time.Duration
	log  *slog.Logger
	live atomic.Bool
}

// New builds a listener; Run starts it.
func New(databaseURL string, connectTimeout time.Duration, stamps Stamps, prefix string, ttl time.Duration, log *slog.Logger) *Listener {
	return &Listener{
		databaseURL:    databaseURL,
		connectTimeout: connectTimeout,
		stamps:         stamps,
		prefix:         prefix,
		keep:           2*ttl + time.Minute,
		log:            log,
	}
}

// Live reports whether every change is being stamped right now. The render
// cache is used only while it is.
func (l *Listener) Live() bool { return l.live.Load() }

// Run listens until ctx ends, reconnecting with backoff. A notification sent
// while no connection listens is lost, so each (re)connect stamps
// `sub:changed:all` once `LISTEN` holds — after it, nothing is missed; before
// it, every entry is outdated.
func (l *Listener) Run(ctx context.Context) {
	backoff := time.Second
	for ctx.Err() == nil {
		err := l.listen(ctx)
		l.live.Store(false)
		if ctx.Err() != nil {
			return
		}
		l.log.Warn("invalidation listener stopped; the render cache is off until it is back", "error", err, "retry_in", backoff)
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}

func (l *Listener) listen(ctx context.Context) error {
	cfg, err := pgx.ParseConfig(l.databaseURL)
	if err != nil {
		return fmt.Errorf("parse database url: %w", err)
	}
	cfg.ConnectTimeout = l.connectTimeout
	cfg.RuntimeParams["application_name"] = db.ApplicationName + "-listener"
	cfg.RuntimeParams["default_transaction_read_only"] = "on"

	conn, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	defer conn.Close(context.Background())

	if _, err := conn.Exec(ctx, "LISTEN "+Channel); err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	if err := l.stamp(ctx, cache.ChangedAllKey(l.prefix)); err != nil {
		return err
	}
	l.live.Store(true)
	l.log.Info("invalidation listener live", "channel", Channel)

	for {
		n, err := conn.WaitForNotification(ctx)
		if err != nil {
			return fmt.Errorf("wait: %w", err)
		}
		// A stamp that cannot be written is a lost notification: drop the
		// connection, so the reconnect outdates everything.
		if err := l.stamp(ctx, l.keyOf(n.Payload)); err != nil {
			return err
		}
	}
}

type payload struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}

// keyOf is the stamp a notification writes. A payload this code does not know
// outdates everything, rather than nothing.
func (l *Listener) keyOf(raw string) string {
	var p payload
	if err := json.Unmarshal([]byte(raw), &p); err == nil && p.ID != "" {
		switch p.Kind {
		case cache.KindPanel, cache.KindGrant, cache.KindTenant:
			return cache.ChangedKey(l.prefix, p.Kind, p.ID)
		}
	}
	l.log.Warn("unknown invalidation payload; outdating every render", "payload", raw)
	return cache.ChangedAllKey(l.prefix)
}

// stamp writes the Redis time into key. The time is read after the
// notification arrived, so it is after the commit that sent it.
func (l *Listener) stamp(ctx context.Context, key string) error {
	now, err := l.stamps.Now(ctx)
	if err != nil {
		return fmt.Errorf("stamp clock: %w", err)
	}
	if err := l.stamps.Set(ctx, key, []byte(strconv.FormatInt(now, 10)), l.keep); err != nil {
		return fmt.Errorf("stamp %s: %w", key, err)
	}
	return nil
}
