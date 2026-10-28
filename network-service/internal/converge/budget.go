package converge

import (
	"errors"
	"time"

	"network-service/internal/driver"
)

// DefaultMaxWrites is the slow writes — creates, recreates and deletes — one
// turn makes. Each is one client call: ~2 s on a Marzban of a few hundred
// users, 4–9 s at 1100 on a loaded disk, so a migration's or a move's
// thousands would hold the turn — and the bulk pass that waits on every turn —
// for an hour (F-027-fj, F-027-fk, LIVE-1). Ten covers a purchase's configs at
// once; the waker carries the rest.
const DefaultMaxWrites = 10

// DefaultWriteWindow is how long a turn keeps making slow writes after its
// first: what the bulk pass waits on a panel in backlog, whatever the panel's
// speed (ADR-0167).
const DefaultWriteWindow = 10 * time.Second

// WriteBudget bounds one turn's slow writes by count and by time; zero values
// are the defaults. Now is the budget's clock (nil: time.Now). Disables,
// ceilings and limit updates are not slow writes: a cut-off never waits.
type WriteBudget struct {
	MaxWrites   int
	WriteWindow time.Duration
	Now         func() time.Time
}

// WriteTally is one turn's spend: Writes attempted, landed or refused;
// Deferred, the ones past the budget, owed the next turn; and Stalled, a panel
// that stopped answering, whose rest waits for the bulk pass (F-027-fk).
type WriteTally struct {
	Writes   int
	Deferred int
	Stalled  bool
	from     time.Time
}

// mayWrite spends one of the turn's slow writes, or counts the write Deferred
// once the budget is spent — by count, or by time since the turn's first
// write, which is always made so a backlog always moves. Asked just before the
// panel is, so a config skipped for no allowance or no inbound spends nothing.
// A deferred config records no outcome: its row is as it was, and the next
// turn reaches it.
func (b WriteBudget) mayWrite(t *WriteTally) bool {
	now := b.now()
	if t.Writes == 0 {
		t.from = now
	}
	if t.Writes >= b.maxWrites() || (t.Writes > 0 && now.Sub(t.from) >= b.window()) {
		t.Deferred++
		return false
	}
	t.Writes++
	return true
}

// noteFailure marks the turn Stalled when the panel gave no answer: our
// deadline or its gateway's, a 429, an open circuit, or a connection that never
// got a status. A 5xx with a status is that one client's refusal and the turn
// goes on — otherwise one bad row, first on every pass, would stop the panel's
// every later write for good.
func (t *WriteTally) noteFailure(err error) {
	if driver.IsTimeout(err) || driver.IsRateLimited(err) || errors.Is(err, driver.ErrCircuitOpen) || (driver.IsUnavailable(err) && statusOf(err) == 0) {
		t.Stalled = true
	}
}

func statusOf(err error) int {
	var fault *driver.Fault
	if errors.As(err, &fault) {
		return fault.Status
	}
	return 0
}

func (b WriteBudget) maxWrites() int {
	if b.MaxWrites > 0 {
		return b.MaxWrites
	}
	return DefaultMaxWrites
}

func (b WriteBudget) window() time.Duration {
	if b.WriteWindow > 0 {
		return b.WriteWindow
	}
	return DefaultWriteWindow
}

func (b WriteBudget) now() time.Time {
	if b.Now != nil {
		return b.Now()
	}
	return time.Now()
}
