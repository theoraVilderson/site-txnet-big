package db

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Options are the pool settings this service runs its connections under.
type Options struct {
	DatabaseURL    string
	MaxConns       int
	MinConns       int
	MaxConnLife    time.Duration
	MaxConnIdle    time.Duration
	ConnectTimeout time.Duration
}

// Pool is the pgx pool, narrowed to what this service is allowed to do with
// it. It satisfies Querier, so the boot assertions run against the real
// connection and against a fake without either knowing which it has.
type Pool struct {
	*pgxpool.Pool
}

// ApplicationName is what this service calls itself in `pg_stat_activity`.
const ApplicationName = "sub-service"

// New opens the pool and waits until one connection has actually been made.
//
// Every connection is opened with `default_transaction_read_only = on`
// (ADR-0082 (1): `/sub` never writes Postgres). The cross-tenant role this
// service connects as could write; the session setting is what makes a write
// from this process an error rather than a review comment, and AssertReady
// checks it took effect.
func New(ctx context.Context, opts Options) (*Pool, error) {
	poolCfg, err := pgxpool.ParseConfig(opts.DatabaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse DATABASE_CROSS_TENANT_URL: %w", err)
	}
	poolCfg.MaxConns = int32(opts.MaxConns)
	poolCfg.MinConns = int32(opts.MinConns)
	poolCfg.MaxConnLifetime = opts.MaxConnLife
	poolCfg.MaxConnIdleTime = opts.MaxConnIdle
	poolCfg.ConnConfig.ConnectTimeout = opts.ConnectTimeout
	if poolCfg.ConnConfig.RuntimeParams == nil {
		poolCfg.ConnConfig.RuntimeParams = map[string]string{}
	}
	poolCfg.ConnConfig.RuntimeParams["application_name"] = ApplicationName
	poolCfg.ConnConfig.RuntimeParams["default_transaction_read_only"] = "on"

	pool, err := pgxpool.NewWithConfig(ctx, poolCfg)
	if err != nil {
		return nil, fmt.Errorf("open pool: %w", err)
	}

	pingCtx, cancel := context.WithTimeout(ctx, opts.ConnectTimeout)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("first connection failed: %w", err)
	}
	return &Pool{Pool: pool}, nil
}

// Query runs a query and returns its rows as this package's narrowed Rows.
func (p *Pool) Query(ctx context.Context, sql string, args ...any) (Rows, error) {
	rows, err := p.Pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	return rows, nil
}

// QueryRow runs a query expected to return at most one row.
func (p *Pool) QueryRow(ctx context.Context, sql string, args ...any) Row {
	return p.Pool.QueryRow(ctx, sql, args...)
}

// AssertReady runs every boot check this service makes of its database: the
// role it connected as, that the session is read-only, then the columns it
// reads. All three refuse rather than warn.
func AssertReady(ctx context.Context, q Querier) error {
	if err := AssertCrossTenantRole(ctx, q); err != nil {
		return err
	}
	if err := AssertReadOnly(ctx, q); err != nil {
		return err
	}
	return AssertColumns(ctx, q)
}
