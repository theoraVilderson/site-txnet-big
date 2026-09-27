package quota

import (
	"math"
	"testing"
	"time"
)

// Rule 4 (wake): the first sample after an idle replica starts consuming is
// measured over max(this poll interval, J) — not J alone (over-reads when polls
// are sparse) and not the whole idle period (under-reads).
func TestRateWakeWindow(t *testing.T) {
	const J = 10 * time.Second
	near := func(t *testing.T, got, want float64) {
		t.Helper()
		if math.Abs(got-want) > want*1e-9 {
			t.Fatalf("Fast = %.0f B/s, want %.0f B/s", got, want)
		}
	}

	t.Run("sparse polls: window is the poll interval, not J", func(t *testing.T) {
		var r Rate
		r.Observe(0, 60*time.Second, false, J) // idle poll
		r.Observe(6_000_000, 60*time.Second, false, J)
		near(t, r.Now(), 100_000) // d/J would read 600 000
	})

	t.Run("dense polls after idle: window is J, not the idle period", func(t *testing.T) {
		var r Rate
		for i := 0; i < 3; i++ {
			r.Observe(0, 5*time.Second, false, J) // 15 s idle, accumulated
		}
		r.Observe(5_000_000, 5*time.Second, false, J)
		near(t, r.Now(), 500_000) // the 20 s idle window would read 250 000
	})

	t.Run("an awake replica keeps the accumulated window", func(t *testing.T) {
		var r Rate
		r.Observe(1_000_000, J, false, J) // wakes: 100 000 B/s
		r.Observe(0, 5*time.Second, false, J)
		r.Observe(3_000_000, 15*time.Second, false, J) // 20 s since the last sample
		near(t, r.Now(), 150_000)
	})
}
