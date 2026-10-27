package converge

import "time"

// DefaultMaxCreates is the creates one turn makes. A create is the one
// unbounded write: ~2 s on a Marzban of a few hundred users, 4–9 s at 1100 on
// a loaded disk, so a migration's thousands would hold the turn — and the bulk
// pass that waits on every turn — for an hour (F-027-fj, LIVE-1). Ten covers a
// purchase's configs at once; the waker carries the rest.
const DefaultMaxCreates = 10

// DefaultCreateWindow is how long a turn keeps creating after its first
// create: what the bulk pass waits on a panel in backlog, whatever the
// panel's speed (ADR-0167).
const DefaultCreateWindow = 10 * time.Second

// CreateBudget bounds one turn's creates by count and by time; zero values are
// the defaults. Now is the budget's clock (nil: time.Now).
type CreateBudget struct {
	MaxCreates   int
	CreateWindow time.Duration
	Now          func() time.Time
}

// CreateTally is one turn's spend: Creates attempted, landed or refused, and
// Deferred, the ones past the budget, left for the next turn.
type CreateTally struct {
	Creates  int
	Deferred int
	from     time.Time
}

// mayCreate spends one of the turn's creates, or counts the create Deferred
// once the budget is spent — by count, or by time since the turn's first
// create, which is always made so a backlog always moves. Asked just before
// the panel is, so a config skipped for no allowance or no inbound spends
// nothing. A deferred config records no outcome: its row is as it was, and the
// next turn reaches it (F-027-fj).
func (b CreateBudget) mayCreate(t *CreateTally) bool {
	now := b.now()
	if t.Creates == 0 {
		t.from = now
	}
	if t.Creates >= b.maxCreates() || (t.Creates > 0 && now.Sub(t.from) >= b.window()) {
		t.Deferred++
		return false
	}
	t.Creates++
	return true
}

func (b CreateBudget) maxCreates() int {
	if b.MaxCreates > 0 {
		return b.MaxCreates
	}
	return DefaultMaxCreates
}

func (b CreateBudget) window() time.Duration {
	if b.CreateWindow > 0 {
		return b.CreateWindow
	}
	return DefaultCreateWindow
}

func (b CreateBudget) now() time.Time {
	if b.Now != nil {
		return b.Now()
	}
	return time.Now()
}
