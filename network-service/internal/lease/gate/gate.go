// Package gate protects one panel from us: adaptive rate (AIMD), bounded
// concurrency, Retry-After, a circuit breaker and single-flight login.
// Every HTTP call to a panel goes through its Gate. One Gate per panel, owned
// by exactly one worker node, so limits are exact without coordination.
package gate

import (
	"context"
	"errors"
	"math"
	"sync"
	"time"
)

type Outcome int

const (
	OK        Outcome = iota
	Throttled         // HTTP 429 / 503 with Retry-After
	Failed            // 5xx, connection error, timeout
	AuthError         // 401/403: session expired
)

var ErrOpen = errors.New("gate: circuit open")

type Config struct {
	InitRate, MinRate, MaxRate float64 // requests/s
	Burst                      float64
	Concurrency                int
	AdditiveStep               float64 // +rate per success (per second of successes)
	BreakAfter                 int     // consecutive failures to open the breaker
	Cooldown                   time.Duration
	MaxCooldown                time.Duration
}

func DefaultConfig() Config {
	return Config{
		InitRate: 2, MinRate: 0.2, MaxRate: 20, Burst: 4, Concurrency: 2,
		AdditiveStep: 0.05, BreakAfter: 5, Cooldown: 15 * time.Second, MaxCooldown: 10 * time.Minute,
	}
}

type Gate struct {
	cfg Config
	sem chan struct{}

	mu        sync.Mutex
	rate      float64
	tokens    float64
	last      time.Time
	notBefore time.Time // Retry-After
	fails     int
	openUntil time.Time
	cooldown  time.Duration
	halfOpen  bool

	now func() time.Time
}

func New(cfg Config) *Gate {
	return &Gate{cfg: cfg, sem: make(chan struct{}, cfg.Concurrency), rate: cfg.InitRate,
		tokens: cfg.Burst, cooldown: cfg.Cooldown, now: time.Now}
}

// Rate is the currently allowed request rate; the planner reads it (as
// PanelState.WriteRate) to stretch lease horizons on slow panels.
func (g *Gate) Rate() float64 { g.mu.Lock(); defer g.mu.Unlock(); return g.rate }

// Healthy is false while the breaker is open.
func (g *Gate) Healthy() bool { g.mu.Lock(); defer g.mu.Unlock(); return !g.now().Before(g.openUntil) }

// Do runs fn under the gate. fn reports the outcome and optional Retry-After.
func (g *Gate) Do(ctx context.Context, fn func(context.Context) (Outcome, time.Duration, error)) error {
	if err := g.wait(ctx); err != nil {
		return err
	}
	select {
	case g.sem <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}
	defer func() { <-g.sem }()
	out, retry, err := fn(ctx)
	g.report(out, retry)
	return err
}

func (g *Gate) wait(ctx context.Context) error {
	for {
		g.mu.Lock()
		now := g.now()
		if now.Before(g.openUntil) {
			g.mu.Unlock()
			return ErrOpen
		}
		if !g.openUntil.IsZero() && !g.halfOpen && g.fails >= g.cfg.BreakAfter {
			g.halfOpen = true // one probe allowed
		}
		if !g.last.IsZero() {
			g.tokens = math.Min(g.cfg.Burst, g.tokens+now.Sub(g.last).Seconds()*g.rate)
		}
		g.last = now
		var sleep time.Duration
		switch {
		case now.Before(g.notBefore):
			sleep = g.notBefore.Sub(now)
		case g.tokens >= 1:
			g.tokens--
			g.mu.Unlock()
			return nil
		default:
			sleep = time.Duration((1 - g.tokens) / g.rate * float64(time.Second))
		}
		g.mu.Unlock()
		t := time.NewTimer(sleep)
		select {
		case <-t.C:
		case <-ctx.Done():
			t.Stop()
			return ctx.Err()
		}
	}
}

func (g *Gate) report(out Outcome, retry time.Duration) {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := g.now()
	switch out {
	case OK, AuthError:
		g.rate = math.Min(g.cfg.MaxRate, g.rate+g.cfg.AdditiveStep)
		g.fails, g.halfOpen, g.cooldown = 0, false, g.cfg.Cooldown
		g.openUntil = time.Time{}
	case Throttled:
		g.rate = math.Max(g.cfg.MinRate, g.rate/2)
		if retry <= 0 {
			retry = time.Duration(1 / g.rate * float64(time.Second))
		}
		g.notBefore = now.Add(retry)
	case Failed:
		g.rate = math.Max(g.cfg.MinRate, g.rate/2)
		g.fails++
		if g.fails >= g.cfg.BreakAfter {
			g.openUntil = now.Add(g.cooldown)
			g.cooldown = min(g.cooldown*2, g.cfg.MaxCooldown) // exponential
			g.halfOpen = false
		}
	}
}

// Session is single-flight login: when N goroutines hit 401 at once, exactly
// one logs in and the rest reuse its token. Login storms are what gets your
// IP banned by fail2ban on panels.
type Session struct {
	mu    sync.Mutex
	token string
	gen   uint64
	login func(context.Context) (string, error)
}

func NewSession(login func(context.Context) (string, error)) *Session {
	return &Session{login: login}
}

// Token returns the current token and its generation (logging in if empty).
func (s *Session) Token(ctx context.Context) (string, uint64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.token == "" {
		t, err := s.login(ctx)
		if err != nil {
			return "", s.gen, err
		}
		s.token = t
		s.gen++
	}
	return s.token, s.gen, nil
}

// Invalidate is called on 401 with the generation that failed; a stale
// generation (someone already re-logged in) is ignored.
func (s *Session) Invalidate(gen uint64) {
	s.mu.Lock()
	if gen == s.gen {
		s.token = ""
	}
	s.mu.Unlock()
}
