package radius

import (
	"encoding/binary"
	"net/netip"
	"time"

	"network-service/internal/collect"
)

// Record is what one accounting packet says about one session.
type Record struct {
	Status    StatusType
	SessionID string
	// UserName is `User-Name`, the remote identifier a config is placed by.
	UserName string
	// NASID is `NAS-Identifier`, or `NAS-IP-Address` when the NAS sends no
	// identifier. Empty means neither; the receiver falls back to the source.
	NASID string
	// The 32-bit wire counters, and their high bits where the NAS sends them.
	InOctets, OutOctets       uint32
	InGigawords, OutGigawords uint32
	// HasGigawords says either Gigawords attribute was present. A NAS that
	// sends them sends zero below 4 GB, so presence is the fact, not value.
	HasGigawords bool
	// SessionTime is `Acct-Session-Time`, which dates a session we first see
	// mid-way.
	SessionTime    time.Duration
	HasSessionTime bool
}

// ReadRecord pulls the attributes accounting uses out of a verified packet. An
// attribute of the wrong width is ignored rather than guessed at.
func ReadRecord(p Packet) Record {
	var r Record
	for _, a := range p.Attributes {
		switch a.Type {
		case AttrUserName:
			r.UserName = string(a.Value)
		case AttrAcctSessionID:
			r.SessionID = string(a.Value)
		case AttrNASIdentifier:
			r.NASID = string(a.Value)
		case AttrNASIPAddress:
			if ip, ok := netip.AddrFromSlice(a.Value); ok && r.NASID == "" {
				r.NASID = ip.String()
			}
		}
		if len(a.Value) != 4 {
			continue
		}
		v := binary.BigEndian.Uint32(a.Value)
		switch a.Type {
		case AttrAcctStatusType:
			r.Status = StatusType(v)
		case AttrAcctInputOctets:
			r.InOctets = v
		case AttrAcctOutputOctets:
			r.OutOctets = v
		case AttrAcctInputGigawords:
			r.InGigawords, r.HasGigawords = v, true
		case AttrAcctOutputGigawords:
			r.OutGigawords, r.HasGigawords = v, true
		case AttrAcctSessionTime:
			r.SessionTime, r.HasSessionTime = time.Duration(v)*time.Second, true
		}
	}
	return r
}

// CloseReason mirrors `network.RadiusSessionCloseReason`. Only acct_stop is
// the NAS telling us; the others are us deciding, which is a weaker figure
// and stays legible as one (invariant 28).
type CloseReason string

const (
	CloseAcctStop     CloseReason = "acct_stop"
	CloseStaleTimeout CloseReason = "stale_timeout"
	CloseNASRestart   CloseReason = "nas_restart"
)

// Session is one `network.radius_session` row as the arithmetic needs it.
// Known is false for a session no row exists for yet.
type Session struct {
	Known bool
	// HighIn/OutBytes are the reconstructed 64-bit high water marks. A
	// session counter only rises, so a lower reading never lowers them.
	HighInBytes, HighOutBytes int64
	// PublishedIn/OutBytes are how much of the mark has been accounted for —
	// billed, held or quarantined. Never above the mark (invariant 27).
	PublishedInBytes, PublishedOutBytes int64
	GigawordsSeen                       bool
	StartedAt, LastSeenAt               time.Time
	// ClosedAt and CloseReason are set together or not at all (invariant 28).
	ClosedAt    time.Time
	CloseReason CloseReason
}

// Limit is the panel's plausibility cap (collect.ExceedsLineRate).
type Limit struct {
	MaxLineRateBps int64
	MinWindow      time.Duration
}

// Outcome is where one packet's rise goes. Input is the user's upload and
// output their download, from the NAS's side of the wire.
type Outcome struct {
	UpBytes, DownBytes int64
	// Held is the rise past 4 GB in a session whose NAS never sent Gigawords:
	// a `gigawords_missing` hold, never a delta (invariant 29).
	HeldUp, HeldDown int64
	// Quarantined is a rise we measured and do not believe.
	QuarantinedUp, QuarantinedDown int64
	Quarantine                     collect.QuarantineReason
}

// Total is every byte the packet accounted for, whichever stream it went to.
func (o Outcome) Total() (up, down int64) {
	return o.UpBytes + o.HeldUp + o.QuarantinedUp, o.DownBytes + o.HeldDown + o.QuarantinedDown
}

const wrap = int64(1) << 32

// Account applies one packet to one session. It writes nothing: the caller
// publishes the Outcome and only then stores the Session, so a failure
// between the two leaves the NAS unacked and the packet comes again.
func Account(cur Session, r Record, at time.Time, lim Limit) (Session, Outcome) {
	next := cur
	if !cur.Known {
		// Counters start at zero with the session (RFC 2866 §5.3), so the
		// first packet we see for it is worth everything it reports: the
		// NAS measured those bytes, even if we missed its Start.
		next = Session{Known: true, StartedAt: at, LastSeenAt: at}
		if r.HasSessionTime {
			next.StartedAt = at.Add(-r.SessionTime)
		}
	}
	next.GigawordsSeen = cur.GigawordsSeen || r.HasGigawords
	next.HighInBytes = max(cur.HighInBytes, total(cur.HighInBytes, r.InOctets, r.InGigawords, r.HasGigawords))
	next.HighOutBytes = max(cur.HighOutBytes, total(cur.HighOutBytes, r.OutOctets, r.OutGigawords, r.HasGigawords))

	var out Outcome
	// Measured without ambiguity: everything, where the NAS sends Gigawords;
	// only what lies below the first wrap, where it does not.
	top := int64(1<<63 - 1)
	if !next.GigawordsSeen {
		top = wrap
	}
	out.UpBytes, out.HeldUp = split(next.PublishedInBytes, next.HighInBytes, top)
	out.DownBytes, out.HeldDown = split(next.PublishedOutBytes, next.HighOutBytes, top)

	since := next.StartedAt
	if cur.Known {
		since = cur.LastSeenAt
	}
	switch {
	case at.Before(since):
		out.Quarantine = collect.ReasonClockWentBackward
	case collect.ExceedsLineRate(lim.MaxLineRateBps, at.Sub(since), lim.MinWindow, out.UpBytes+out.DownBytes):
		out.Quarantine = collect.ReasonImplausibleVolume
	}
	if out.Quarantine != "" && out.UpBytes+out.DownBytes > 0 {
		out.QuarantinedUp, out.QuarantinedDown = out.UpBytes, out.DownBytes
		out.UpBytes, out.DownBytes = 0, 0
	} else {
		out.Quarantine = ""
	}

	// The whole rise is accounted for in one of three streams, so the
	// published mark moves to the high water mark and never past it.
	next.PublishedInBytes, next.PublishedOutBytes = next.HighInBytes, next.HighOutBytes
	if at.After(next.LastSeenAt) {
		next.LastSeenAt = at
	}
	if r.Status == StatusStop && next.CloseReason == "" {
		next.ClosedAt, next.CloseReason = at, CloseAcctStop
	}
	return next, out
}

// total is one direction's 64-bit figure. With Gigawords it is exact. Without,
// the high bits are taken from the mark, and a reading below it is read as one
// more wrap — the smallest figure consistent with a counter that only rises.
// That is a guess, which is why whatever it puts past 4 GB is held (split).
// With Gigawords, a reading below the mark is a restart and max() discards it.
func total(mark int64, octets, gigawords uint32, hasGigawords bool) int64 {
	if hasGigawords {
		return int64(gigawords)<<32 | int64(octets)
	}
	v := mark&^(wrap-1) | int64(octets)
	if v < mark {
		v += wrap
	}
	return v
}

// split divides the rise from published to high into what is billable (below
// top) and what is held (above it).
func split(published, high, top int64) (billed, held int64) {
	rise := high - published
	if rise <= 0 {
		return 0, 0
	}
	billed = max(0, min(high, top)-published)
	return billed, rise - billed
}
