package quota

import (
	"math/rand"
	"testing"
	"time"
)

func TestTickClockConverges(t *testing.T) {
	J := 10 * time.Second
	t0 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for _, phase := range []time.Duration{0, 1300 * time.Millisecond, 7 * time.Second, 9900 * time.Millisecond} {
		c := NewTickClock(J)
		rng := rand.New(rand.NewSource(int64(phase)))
		prev := t0
		for i := 0; i < 12; i++ {
			now := prev.Add(time.Duration(2+rng.Intn(6)) * time.Second)
			// did a tick at phase+kJ fall in (prev, now]?
			changed := c.lastTick(now, phase).After(prev)
			c.Observe(prev, now, changed, true)
			prev = now
		}
		if !c.Known() {
			t.Fatalf("phase %v not known, mask %032b", phase, c.mask)
		}
		probe := t0.Add(123*time.Second + 400*time.Millisecond)
		want := c.lastTick(probe, phase)
		got := c.Effective(probe)
		if d := got.Sub(want); d < -time.Second || d > time.Second {
			t.Fatalf("phase %v: effective off by %v", phase, d)
		}
	}
}
