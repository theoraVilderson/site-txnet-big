package radius

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/netip"
	"time"

	"network-service/internal/collect"
)

// NAS is one accepted push panel as the receiver needs it. One panel row is
// one NAS: its `ipAddress` is the allowlist entry and its RADIUS secret, a
// vault reference of its own beside the REST login (F-027-az), is the shared
// secret, so two NASes never share a secret unless an operator typed the same
// one twice.
type NAS struct {
	PanelID       string
	OwnershipType string
	TenantID      string
	Secret        []byte
	Limit         Limit
}

// Directory answers which NAS, if any, a source address is.
type Directory interface {
	NAS(addr netip.Addr) (NAS, bool)
}

// Key is a session's identity: `Acct-Session-Id` is unique only within the
// NAS that issued it (invariant 26).
type Key struct {
	PanelID   string
	NASID     string
	SessionID string
}

// Placement is the config a remote identifier belongs to on this panel. Empty
// is a session no config claims; its bytes are unattributed, not dropped.
type Placement struct {
	ConfigID string
	Protocol string
}

// Hold is a `gigawords_missing` row in `network.usage_hold`.
type Hold struct {
	ConfigID  string
	PanelID   string
	UpBytes   int64
	DownBytes int64
	HeldFrom  time.Time
}

// Apply is the work done over one locked session row. It returns the row to
// store and a hold to write with it; an error writes neither.
type Apply func(cur Session, place Placement) (Session, *Hold, error)

// Store is `network.radius_session` (and the holds written beside it).
type Store interface {
	// Account locks the session's row (Known false if there is none), places
	// remoteID, runs fn, and stores what it returns in the same transaction.
	Account(ctx context.Context, k Key, remoteID string, fn Apply) error
	// CloseNAS closes every open session of one NAS at its last observed
	// figure — the NAS said it restarted, so none of them will Stop.
	CloseNAS(ctx context.Context, panelID, nasID string, at time.Time) (int, error)
	// CloseStale closes every open session last seen before cutoff, at its
	// last observed figure.
	CloseStale(ctx context.Context, cutoff time.Time) (int, error)
}

// Sink is where a packet's bytes leave this process: publish.Publisher.
type Sink interface {
	Publish(ctx context.Context, res collect.Result) error
}

var (
	// ErrNotAllowed is a source that is no accepted push panel.
	ErrNotAllowed = errors.New("radius: source is not an allowlisted NAS")
	// ErrNotAccounting is a verified packet that is not an Accounting-Request.
	ErrNotAccounting = errors.New("radius: not an accounting request")
	// ErrNoSessionID is a session packet naming no session: there is no row
	// it could be kept against, and acking it would drop its bytes.
	ErrNoSessionID = errors.New("radius: session packet without Acct-Session-Id")
)

// Receiver turns accounting packets into published deltas.
type Receiver struct {
	Directory Directory
	Store     Store
	Sink      Sink
	Log       *slog.Logger
	Now       func() time.Time
	// Concurrency bounds packets in flight. A burst of Interims after a NAS
	// reboot would otherwise be one goroutine and one pooled connection each.
	Concurrency int
}

// Handle answers one datagram. A nil reply is a silent discard (RFC 2866
// §3: a request that fails verification gets no response) or a failure the
// NAS must retransmit through.
func (r *Receiver) Handle(ctx context.Context, src netip.Addr, b []byte) ([]byte, error) {
	nas, ok := r.Directory.NAS(src.Unmap())
	if !ok {
		return nil, ErrNotAllowed
	}
	p, err := Parse(b, nas.Secret)
	if err != nil {
		return nil, err
	}
	if p.Code != CodeAccountingRequest {
		return nil, ErrNotAccounting
	}
	rec := ReadRecord(p)
	if rec.NASID == "" {
		rec.NASID = src.Unmap().String()
	}
	at := r.now()

	switch rec.Status {
	case StatusAccountingOn, StatusAccountingOff:
		if _, err := r.Store.CloseNAS(ctx, nas.PanelID, rec.NASID, at); err != nil {
			return nil, err
		}
	case StatusStart, StatusInterimUpdate, StatusStop:
		if rec.SessionID == "" {
			return nil, ErrNoSessionID
		}
		k := Key{PanelID: nas.PanelID, NASID: rec.NASID, SessionID: rec.SessionID}
		if err := r.Store.Account(ctx, k, rec.UserName, r.apply(ctx, nas, rec, at)); err != nil {
			return nil, err
		}
	default:
		// A status this receiver has no use for is acknowledged, or the NAS
		// would retransmit it for ever.
	}
	return Response(p, nas.Secret), nil
}

// apply is Account plus the publish: the delta leaves before the row moves.
func (r *Receiver) apply(ctx context.Context, nas NAS, rec Record, at time.Time) Apply {
	return func(cur Session, place Placement) (Session, *Hold, error) {
		next, out := Account(cur, rec, at, nas.Limit)
		res := collect.Result{
			PanelID: nas.PanelID, OwnershipType: nas.OwnershipType, TenantID: nas.TenantID,
			ObservedAt: at,
		}
		var hold *Hold
		switch {
		case place.ConfigID == "":
			if up, down := out.Total(); up+down > 0 {
				res.Unattributed = append(res.Unattributed, collect.Unattributed{
					PanelID: nas.PanelID, RemoteIdentifier: rec.UserName,
					UpBytes: up, DownBytes: down, ObservedAt: at,
				})
			}
		default:
			if out.UpBytes+out.DownBytes > 0 {
				res.Deltas = append(res.Deltas, collect.Delta{
					PanelID: nas.PanelID, ConfigID: place.ConfigID, RemoteID: rec.UserName,
					Protocol: place.Protocol, UpBytes: out.UpBytes, DownBytes: out.DownBytes,
					ObservedAt: at, SessionID: rec.SessionID,
				})
			}
			if out.Quarantine != "" {
				res.Quarantines = append(res.Quarantines, collect.Quarantine{
					PanelID: nas.PanelID, ConfigID: place.ConfigID, RemoteID: rec.UserName,
					UpBytes: out.QuarantinedUp, DownBytes: out.QuarantinedDown,
					ObservedAt: at, Reason: out.Quarantine,
				})
			}
			if out.HeldUp+out.HeldDown > 0 {
				hold = &Hold{ConfigID: place.ConfigID, PanelID: nas.PanelID,
					UpBytes: out.HeldUp, DownBytes: out.HeldDown, HeldFrom: cur.LastSeenAt}
				if !cur.Known {
					hold.HeldFrom = next.StartedAt
				}
			}
		}
		if len(res.Deltas)+len(res.Quarantines)+len(res.Unattributed) > 0 {
			if err := r.Sink.Publish(ctx, res); err != nil {
				return Session{}, nil, fmt.Errorf("publishing session %s: %w", rec.SessionID, err)
			}
		}
		return next, hold, nil
	}
}

// Serve reads conn until ctx ends. Every drop is logged at debug and nothing
// is answered: a reply to an unlisted source is an amplifier.
func (r *Receiver) Serve(ctx context.Context, conn net.PacketConn) error {
	go func() {
		<-ctx.Done()
		_ = conn.Close()
	}()
	slots := make(chan struct{}, max(r.Concurrency, 1))
	for {
		buf := make([]byte, MaxPacketLen)
		n, from, err := conn.ReadFrom(buf)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return fmt.Errorf("radius read: %w", err)
		}
		udp, ok := from.(*net.UDPAddr)
		if !ok {
			continue
		}
		src, _ := netip.AddrFromSlice(udp.IP)
		slots <- struct{}{}
		go func() {
			defer func() { <-slots }()
			reply, err := r.Handle(ctx, src, buf[:n])
			if err != nil {
				r.log().Debug("radius packet not acknowledged", "source", src.String(), "error", err)
				return
			}
			if _, err := conn.WriteTo(reply, from); err != nil {
				r.log().Warn("radius reply failed", "source", src.String(), "error", err)
			}
		}()
	}
}

func (r *Receiver) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now().UTC()
}

func (r *Receiver) log() *slog.Logger {
	if r.Log != nil {
		return r.Log
	}
	return slog.Default()
}

// DefaultStaleAfter is how long an open session may go unheard before it is
// closed at its last observed figure. NASes send an Interim every 5-15
// minutes; four missed ones is a session whose Stop is not coming.
const DefaultStaleAfter = time.Hour

// Sweeper closes sessions whose Stop never came. It publishes nothing: every
// Interim already published its rise, and anything after the last one was
// never observed — extrapolating to it is what invariant 27 forbids.
type Sweeper struct {
	Store      Store
	StaleAfter time.Duration
	Log        *slog.Logger
}

// Run sweeps every quarter of StaleAfter until ctx ends.
func (s Sweeper) Run(ctx context.Context) {
	after := s.StaleAfter
	if after <= 0 {
		after = DefaultStaleAfter
	}
	t := time.NewTicker(after / 4)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-t.C:
			n, err := s.Store.CloseStale(ctx, now.UTC().Add(-after))
			if err != nil {
				s.Log.Error("closing stale radius sessions failed", "error", err)
			} else if n > 0 {
				s.Log.Info("closed stale radius sessions", "count", n)
			}
		}
	}
}
