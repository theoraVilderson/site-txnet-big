package collect

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"network-service/internal/db"
	"network-service/internal/driver"
)

// The loop's state on `network.*` (F-027-bt), through the cross-tenant pool:
// one pass spans every tenant's panels. These replace `MemoryCursors`,
// `MemoryDriftEvents` and the nil Progress and Rates a single-process run had,
// and the memory ones stay as what the loop is proved against.

// DB is what the stores need of the pool: db.Pool satisfies it, and a test
// can too.
type DB interface {
	Query(ctx context.Context, sql string, args ...any) (db.Rows, error)
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// PostgresCursors is Cursors over `network.config_counter_state`, held in
// memory between writes: the getters are called inside the normaliser, per
// client, and a query each is five thousand queries a pass.
//
// The row is keyed by config and the getters by the panel's client id, so the
// map is rebuilt from the join every pass (`reload`). A client re-keyed by the
// convergence pass (F-027-aa) is therefore found under its new id on the next
// pass, with the cursor it already had.
//
// Apply writes through: the database first, then the map, under one lock that
// reload also holds across its query. A reload that read the table before an
// apply committed can then never overwrite the apply's cursor with the older
// one, which would be the same bytes billed twice.
type PostgresCursors struct {
	DB DB

	mu       sync.Mutex
	counters map[string]Counter
}

var _ Cursors = (*PostgresCursors)(nil)

// cursorsSQL is every claimed client on the offered panels, with its cursor
// where it has one. A config with no `remoteId` has no client to read.
const cursorsSQL = `
SELECT c."panelId"::text, c.id::text, c."remoteId", c.protocol::text,
       s.id IS NOT NULL, coalesce(s."counterSemantics"::text, ''),
       coalesce(s."lastUpBytes", 0), coalesce(s."lastDownBytes", 0),
       coalesce(s."lifetimeUpBytes", 0), coalesce(s."lifetimeDownBytes", 0),
       s."lastObservedAt", coalesce(s."resetCount", 0), s."lastResetAt",
       coalesce(s."limitOriginId", ''), coalesce(s."limitOriginBytes", 0), s."limitOriginAt",
       p.transport = 'push', rs."in", rs."out", c."sessionBaselineBytes"
  FROM network.config c
  JOIN network.panel p ON p.id = c."panelId"
  LEFT JOIN network.config_counter_state s ON s."configId" = c.id
  CROSS JOIN LATERAL (` + sessionSumSQL + `) rs
 WHERE c."panelId" = ANY($1::uuid[])
   AND c."remoteId" IS NOT NULL`

// sessionSumSQL is one config's `radius_session` marks, summed (F-027-du).
const sessionSumSQL = `SELECT coalesce(sum(r."highWaterInBytes"), 0)::bigint AS "in",
       coalesce(sum(r."highWaterOutBytes"), 0)::bigint AS "out"
  FROM network.radius_session r WHERE r."configId" = c.id`

// reload replaces the map with what the table holds for these panels and
// returns their configs, keyed by client id, for the pass's Panel.Configs.
func (c *PostgresCursors) reload(ctx context.Context, panelIDs []string) (map[string]map[string]ConfigRef, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	rows, err := c.DB.Query(ctx, cursorsSQL, panelIDs)
	if err != nil {
		return nil, fmt.Errorf("reading cursors: %w", err)
	}
	defer rows.Close()
	configs := map[string]map[string]ConfigRef{}
	counters := map[string]Counter{}
	for rows.Next() {
		var panelID, remoteID, semantics string
		var ref ConfigRef
		var has bool
		var cur Counter
		var observed, reset, origin *time.Time
		var push bool
		var in, out, baseline int64
		if err := rows.Scan(&panelID, &ref.ConfigID, &remoteID, &ref.Protocol, &has, &semantics,
			&cur.LastUpBytes, &cur.LastDownBytes, &cur.LifetimeUpBytes, &cur.LifetimeDownBytes,
			&observed, &cur.ResetCount, &reset, &cur.LimitOriginID, &cur.LimitOriginBytes, &origin,
			&push, &in, &out, &baseline); err != nil {
			return nil, fmt.Errorf("reading cursors: %w", err)
		}
		if configs[panelID] == nil {
			configs[panelID] = map[string]ConfigRef{}
		}
		configs[panelID][remoteID] = ref
		if push {
			counters[key(panelID, remoteID)] = SessionCounter(in, out, baseline)
			continue
		}
		if !has {
			continue
		}
		cur.Semantics = driver.CounterSemantics(semantics)
		if observed != nil {
			cur.LastObservedAt = observed.UTC()
		}
		if reset != nil {
			cur.LastResetAt = reset.UTC()
		}
		if origin != nil {
			cur.LimitOriginAt = origin.UTC()
		}
		k := key(panelID, remoteID)
		counters[k] = carryClock(cur, c.counters[k])
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("reading cursors: %w", err)
	}
	c.counters = counters
	return configs, nil
}

// CursorKey is where a cursor is found: the panel, and its client id there.
type CursorKey struct{ PanelID, RemoteID string }

// Merge runs read under the lock reload and Apply hold, and folds the cursors
// it returns into the map. It is how a reader with a statement of its own —
// the hot loop's candidates (F-027-bu) — brings its cursors up to date
// between two bulk passes, with the same guarantee reload has: an apply
// cannot land between the read and the fold.
func (c *PostgresCursors) Merge(read func() (map[CursorKey]Counter, error)) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	got, err := read()
	if err != nil {
		return err
	}
	if c.counters == nil {
		c.counters = map[string]Counter{}
	}
	for k, cur := range got {
		mk := key(k.PanelID, k.RemoteID)
		c.counters[mk] = carryClock(cur, c.counters[mk])
	}
	return nil
}

// carryClock keeps the map's later clock for a cursor the table holds
// unmoved: Apply skips writing a standing cursor (applySQL), so the table's
// `lastObservedAt` lags, and the cap and the rate samples measure their
// window from it. A cursor that moved is the table's whole.
func carryClock(stored, held Counter) Counter {
	if sameCounts(stored, held) && held.LastObservedAt.After(stored.LastObservedAt) {
		stored.LastObservedAt = held.LastObservedAt
	}
	return stored
}

// sameCounts is every field applySQL compares; the times within the column's
// millisecond, since the map holds the pass's own clock.
func sameCounts(a, b Counter) bool {
	sameTime := func(x, y time.Time) bool { return x.Sub(y).Abs() < time.Millisecond }
	return a.Semantics == b.Semantics && a.LastUpBytes == b.LastUpBytes && a.LastDownBytes == b.LastDownBytes &&
		a.LifetimeUpBytes == b.LifetimeUpBytes && a.LifetimeDownBytes == b.LifetimeDownBytes &&
		a.ResetCount == b.ResetCount && sameTime(a.LastResetAt, b.LastResetAt) &&
		a.LimitOriginID == b.LimitOriginID && a.LimitOriginBytes == b.LimitOriginBytes &&
		sameTime(a.LimitOriginAt, b.LimitOriginAt)
}

func (c *PostgresCursors) Counter(panelID, remoteID string) (Counter, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	cur, ok := c.counters[key(panelID, remoteID)]
	return cur, ok
}

// Session is always unknown: a session panel is never offered to this loop.
func (c *PostgresCursors) Session(string, string, string) (SessionMark, bool) {
	return SessionMark{}, false
}

// observedRefresh is how far a standing cursor's stored `lastObservedAt` may
// fall behind before it is written anyway (LIVE-1-ad): it bounds how much
// wider than a pass the cap's window can be after a restart.
const observedRefresh = 10 * time.Minute

// applySQL moves every cursor of a pass in one statement. `lastPublishedAt`
// is the pass's clock: Apply runs only after the publish (invariant 18).
// A cursor whose counters stand still is skipped until its stored clock is
// observedRefresh old (LIVE-1-ad): rewriting it was a third of the node
// disk's writes at idle, and it holds nothing a re-read could lose.
const applySQL = `
WITH v AS (
SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::bigint[], $5::bigint[], $6::bigint[],
              $7::bigint[], $8::timestamp(3)[], $9::int[], $10::timestamp(3)[],
              $12::text[], $13::bigint[], $14::timestamp(3)[])
       AS v(config, panel, semantics, up, down, lifetime_up, lifetime_down, observed, resets, reset_at,
            origin, origin_bytes, origin_at))
INSERT INTO network.config_counter_state AS s
       (id, "configId", "panelId", "counterSemantics", "lastUpBytes", "lastDownBytes",
        "lifetimeUpBytes", "lifetimeDownBytes", "lastObservedAt", "lastPublishedAt",
        "resetCount", "lastResetAt", "limitOriginId", "limitOriginBytes", "limitOriginAt", "updatedAt")
SELECT gen_random_uuid(), v.config::uuid, v.panel::uuid, v.semantics::network."CounterSemantics",
       v.up, v.down, v.lifetime_up, v.lifetime_down, v.observed, $11, v.resets, v.reset_at,
       NULLIF(v.origin, ''), v.origin_bytes, v.origin_at, now()
  FROM v
  LEFT JOIN network.config_counter_state s ON s."configId" = v.config::uuid
 WHERE s.id IS NULL
    OR (s."panelId", s."counterSemantics", s."lastUpBytes", s."lastDownBytes", s."lifetimeUpBytes",
        s."lifetimeDownBytes", s."resetCount", s."lastResetAt", s."limitOriginId", s."limitOriginBytes", s."limitOriginAt")
       IS DISTINCT FROM
       (v.panel::uuid, v.semantics::network."CounterSemantics", v.up, v.down, v.lifetime_up,
        v.lifetime_down, v.resets, v.reset_at, NULLIF(v.origin, ''), v.origin_bytes, v.origin_at)
    OR s."lastObservedAt" IS NULL
    OR s."lastObservedAt" < v.observed - $15::int * interval '1 second'
ON CONFLICT ("configId") DO UPDATE
   SET "panelId" = EXCLUDED."panelId",
       "counterSemantics" = EXCLUDED."counterSemantics",
       "lastUpBytes" = EXCLUDED."lastUpBytes",
       "lastDownBytes" = EXCLUDED."lastDownBytes",
       "lifetimeUpBytes" = EXCLUDED."lifetimeUpBytes",
       "lifetimeDownBytes" = EXCLUDED."lifetimeDownBytes",
       "lastObservedAt" = EXCLUDED."lastObservedAt",
       "lastPublishedAt" = EXCLUDED."lastPublishedAt",
       "resetCount" = EXCLUDED."resetCount",
       "lastResetAt" = EXCLUDED."lastResetAt",
       "limitOriginId" = EXCLUDED."limitOriginId",
       "limitOriginBytes" = EXCLUDED."limitOriginBytes",
       "limitOriginAt" = EXCLUDED."limitOriginAt",
       "updatedAt" = EXCLUDED."updatedAt"`

// ErrUnstorableAdvance is an advance this table has no place for: a session
// mark (`radius_session`'s) or a client no config claims. Refusing the whole
// pass leaves the cursors where they were, so it is republished rather than a
// mark dropped and billed again.
var ErrUnstorableAdvance = errors.New("advance has no config_counter_state row to live in")

func (c *PostgresCursors) Apply(ctx context.Context, res Result) error {
	if len(res.Advances) == 0 {
		return nil
	}
	n := len(res.Advances)
	configs, panels, semantics := make([]string, n), make([]string, n), make([]string, n)
	up, down, lifeUp, lifeDown := make([]int64, n), make([]int64, n), make([]int64, n), make([]int64, n)
	observed, resetAt, originAt := make([]*time.Time, n), make([]*time.Time, n), make([]*time.Time, n)
	resets := make([]int32, n)
	origins, originBytes := make([]string, n), make([]int64, n)
	for i, a := range res.Advances {
		if a.Session != nil || a.ConfigID == "" {
			return fmt.Errorf("%w: panel %s client %s", ErrUnstorableAdvance, a.PanelID, a.RemoteID)
		}
		cur := a.Counter
		configs[i], panels[i], semantics[i] = a.ConfigID, a.PanelID, string(cur.Semantics)
		up[i], down[i], lifeUp[i], lifeDown[i] = cur.LastUpBytes, cur.LastDownBytes, cur.LifetimeUpBytes, cur.LifetimeDownBytes
		observed[i], resetAt[i], resets[i] = nullableTime(cur.LastObservedAt), nullableTime(cur.LastResetAt), int32(cur.ResetCount)
		origins[i], originBytes[i], originAt[i] = cur.LimitOriginID, cur.LimitOriginBytes, nullableTime(cur.LimitOriginAt)
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	if _, err := c.DB.Exec(ctx, applySQL, configs, panels, semantics, up, down, lifeUp, lifeDown,
		observed, resets, resetAt, res.ObservedAt, origins, originBytes, originAt,
		int32(observedRefresh/time.Second)); err != nil {
		return fmt.Errorf("moving panel %s cursors: %w", res.PanelID, err)
	}
	if c.counters == nil {
		c.counters = map[string]Counter{}
	}
	for _, a := range res.Advances {
		c.counters[key(a.PanelID, a.RemoteID)] = a.Counter
	}
	return nil
}

// PostgresProgress is Progress over `panel.lastSuccessfulCollectionAt`. The
// clock never moves backward: a slow turn landing after a faster one must not
// make a panel look staler than it is.
type PostgresProgress struct {
	DB DB
}

var _ Progress = PostgresProgress{}

const progressSQL = `
UPDATE network.panel p
   SET "lastSuccessfulCollectionAt" = greatest(p."lastSuccessfulCollectionAt", v.at)
  FROM unnest($1::text[], $2::timestamp(3)[]) AS v(id, at)
 WHERE p.id = v.id::uuid`

func (s PostgresProgress) Collected(ctx context.Context, marks []PanelProgress) error {
	if len(marks) == 0 {
		return nil
	}
	ids, at := make([]string, len(marks)), make([]time.Time, len(marks))
	for i, m := range marks {
		ids[i], at[i] = m.PanelID, m.At
	}
	if _, err := s.DB.Exec(ctx, progressSQL, ids, at); err != nil {
		return fmt.Errorf("stamping collection progress: %w", err)
	}
	return nil
}

// PostgresRates is Rates over `config.observedRateBps`, the figure the hot
// loop judges membership on (`contract.hot-loop.md`).
type PostgresRates struct {
	DB DB
}

var _ Rates = PostgresRates{}

// In id order: the bulk and hot loops write the same panel's rates (F-027-cv).
var ratesSQL = db.OrderedConfigUpdate(`"observedRateBps" = v.rate`,
	`unnest($1::text[], $2::bigint[]) AS v(id, rate)`)

func (s PostgresRates) Record(ctx context.Context, samples []RateSample) error {
	if len(samples) == 0 {
		return nil
	}
	ids, rates := make([]string, len(samples)), make([]int64, len(samples))
	for i, r := range samples {
		ids[i], rates[i] = r.ConfigID, r.RateBps
	}
	if _, err := s.DB.Exec(ctx, ratesSQL, ids, rates); err != nil {
		return fmt.Errorf("recording observed rates: %w", err)
	}
	return nil
}

func nullableTime(t time.Time) *time.Time {
	if t.IsZero() {
		return nil
	}
	return &t
}

// SessionCounter is a push config's counter (F-027-du): its lifetime is the
// Σ of its `radius_session` marks, and the panel's own figure, which starts
// at the client's create, is that Σ less the Σ it was created at. The offset every ceiling on it is translated by is
// therefore the baseline, as a pull panel's is the bytes its counter lost.
func SessionCounter(in, out, baseline int64) Counter {
	return Counter{
		Semantics: driver.CounterSession, LifetimeUpBytes: in, LifetimeDownBytes: out,
		LastDownBytes: max(in+out-baseline, 0),
	}
}

var _ SessionTotals = (*PostgresCursors)(nil)

// totalsSQL is every claimed client on one push panel with its sessions'
// marks summed and its baseline. A client with no session yet reads zero,
// so its Grant is planned all the same.
const totalsSQL = `
SELECT c."remoteId", rs."in", rs."out", c."sessionBaselineBytes"
  FROM network.config c
  CROSS JOIN LATERAL (` + sessionSumSQL + `) rs
 WHERE c."panelId" = $1::uuid
   AND c."remoteId" IS NOT NULL
 ORDER BY c."remoteId"`

// Totals is SessionTotals: a push panel's reading, one per claimed client,
// the figure the panel's own limit is checked against (SessionCounter). It
// folds the same counters into the map through Merge, so the convergence
// step right after it translates each ceiling by the baseline as it now
// stands — a client created since the last bulk pass included.
func (c *PostgresCursors) Totals(ctx context.Context, panelID string) ([]driver.ClientUsage, error) {
	var out []driver.ClientUsage
	err := c.Merge(func() (map[CursorKey]Counter, error) {
		rows, err := c.DB.Query(ctx, totalsSQL, panelID)
		if err != nil {
			return nil, fmt.Errorf("reading the session totals of panel %s: %w", panelID, err)
		}
		defer rows.Close()
		at := time.Now().UTC()
		got := map[CursorKey]Counter{}
		for rows.Next() {
			var remoteID string
			var in, sent, baseline int64
			if err := rows.Scan(&remoteID, &in, &sent, &baseline); err != nil {
				return nil, fmt.Errorf("reading the session totals of panel %s: %w", panelID, err)
			}
			cur := SessionCounter(in, sent, baseline)
			got[CursorKey{PanelID: panelID, RemoteID: remoteID}] = cur
			// One total, in DownBytes: the split of what is left past a
			// baseline is a number nobody measured (driver.ClientUsage).
			out = append(out, driver.ClientUsage{RemoteID: remoteID, DownBytes: cur.LastDownBytes, ObservedAt: at})
		}
		return got, rows.Err()
	})
	return out, err
}
