package leaseplan_test

import (
	"context"
	"math/rand"
	"testing"
	"time"

	"network-service/internal/driver"
	"network-service/internal/lease/quota"
	"network-service/internal/leaseplan"
)

// The cutover (F-027-db, ADR-0093 rules 1-2): the planner is the only writer
// of `allocatedCeilingBytes`, and it writes two-phase. A shrink frees budget
// only once the panel shows it, and a grow is paid only from what is free, so
// at every moment the figure each panel may enforce — the one it holds until
// our write lands, or ours once it has — still fits in the bag. The rows
// carry the peak and the write in flight, so a restart keeps that promise.

// bench is one Grant on one cumulative panel, with a panel that takes a
// written figure one to three turns later — the queue, the budget, a slow
// family — and cuts a client exactly at what it holds.
type bench struct {
	t        *testing.T
	s        *store
	pl       *leaseplan.Planner
	ids      []string
	applied  map[string]int64 // what the panel enforces, 0 = no client yet
	inflight map[string][]landing
	counter  map[string]int64
	quota    int64
	at       time.Time
	n        int
	rng      *rand.Rand
	plans    []leaseplan.Plan
}

// landing is a figure written to a panel, enforced from turn `at` on.
type landing struct {
	bytes int64
	at    int
}

func newBench(t *testing.T, quotaBytes int64, ids ...string) *bench {
	b := &bench{t: t, s: newStore(), ids: ids, applied: map[string]int64{}, inflight: map[string][]landing{},
		counter: map[string]int64{}, quota: quotaBytes, at: time.Date(2026, 9, 27, 10, 0, 0, 0, time.UTC),
		rng: rand.New(rand.NewSource(1))}
	b.pl = &leaseplan.Planner{Store: b.s}
	configs := make([]leaseplan.Config, len(ids))
	for i, id := range ids {
		configs[i] = leaseplan.Config{ID: "config-" + id, PanelID: panelID, Enabled: true}
	}
	b.s.grants = []leaseplan.Grant{{ID: "grant-1", Quota: quotaBytes, Configs: configs}}
	return b
}

func (b *bench) row(id string) *leaseplan.Config {
	for i := range b.s.grants[0].Configs {
		if c := &b.s.grants[0].Configs[i]; c.ID == "config-"+id {
			return c
		}
	}
	b.t.Fatalf("no row for %s", id)
	return nil
}

// turn lands what is due, serves traffic, and runs one collection turn's plan
// over the readings; what the plan wrote goes to the panel's queue.
func (b *bench) turn(served map[string]int64) {
	b.t.Helper()
	for _, id := range b.ids {
		q := b.inflight[id]
		for len(q) > 0 && q[0].at <= b.n {
			b.applied[id], q = q[0].bytes, q[1:]
		}
		b.inflight[id] = q
	}
	var readings []driver.ClientUsage
	used := int64(0)
	for _, id := range b.ids {
		c := b.row(id)
		if b.applied[id] > 0 {
			b.counter[id] = min(b.counter[id]+served[id], b.applied[id])
			readings = append(readings, reading(id, b.counter[id]))
		}
		used += b.counter[id]
		c.Exists, c.Counter, c.LimitSeen = b.applied[id] > 0, b.counter[id], b.applied[id]
	}
	b.s.grants[0].Used = used
	plans, err := b.pl.Plan(context.Background(), panel(b.ids...), readings, b.at)
	if err != nil {
		b.t.Fatal(err)
	}
	b.plans = append(b.plans, plans...)
	for _, id := range b.ids { // the convergence step: queued, in order
		a := b.row(id).Allocated
		if a == nil {
			continue
		}
		last := b.applied[id]
		if q := b.inflight[id]; len(q) > 0 {
			last = q[len(q)-1].bytes
		}
		if *a != last {
			at := b.n + 1 + b.rng.Intn(3)
			if q := b.inflight[id]; len(q) > 0 {
				at = max(at, q[len(q)-1].at)
			}
			b.inflight[id] = append(b.inflight[id], landing{*a, at})
		}
	}
	b.at = b.at.Add(time.Minute)
	b.n++
}

// exposure is what the panels may still serve: per config, the highest of
// what it enforces, what is queued for it and what the row says, less what
// it has served.
func (b *bench) exposure() (used, room int64) {
	for _, id := range b.ids {
		used += b.counter[id]
		limit := b.applied[id]
		for _, l := range b.inflight[id] {
			limit = max(limit, l.bytes)
		}
		if a := b.row(id).Allocated; a != nil {
			limit = max(limit, *a)
		}
		room += max(limit-b.counter[id], 0)
	}
	return used, room
}

// The property, over a bag whose consumer moves between three configs every
// few minutes, through two restarts: Used plus every panel's room never
// passes Quota, whichever of the old and new figure a panel is enforcing.
func TestAShareMovesOnlyThroughWhatIsFree(t *testing.T) {
	for seed := int64(1); seed <= 20; seed++ {
		b := newBench(t, quota.GB, "c1", "c2", "c3")
		rng := rand.New(rand.NewSource(seed))
		b.rng = rand.New(rand.NewSource(seed * 7919))
		hot := "c1"
		for i := 0; i < 60; i++ {
			if i%4 == 0 {
				hot = b.ids[rng.Intn(len(b.ids))]
			}
			if i == 13 || i == 29 {
				b.pl = &leaseplan.Planner{Store: b.s} // a deploy: only the rows survive
			}
			served := map[string]int64{hot: int64(rng.Intn(60)) * quota.MB}
			for _, id := range b.ids {
				if id != hot && rng.Intn(3) == 0 {
					served[id] = int64(rng.Intn(4)) * quota.MB
				}
			}
			b.turn(served)
			if used, room := b.exposure(); used+room > b.quota {
				t.Fatalf("seed %d turn %d: used %d MiB + room %d MiB > quota %d MiB",
					seed, i, used/quota.MB, room/quota.MB, b.quota/quota.MB)
			}
		}
	}
}

// A shrink is written with its peak held at the old figure and a write in
// flight; the peak comes down only once the panel shows the new one.
func TestAShrinkIsFreedOnlyOnConfirm(t *testing.T) {
	b := newBench(t, quota.GB, "c1", "c2")
	for i := 0; i < 4; i++ { // first shares, and the clients exist
		b.turn(nil)
	}
	var shrunk string
	var was int64
	for i := 0; i < 20 && shrunk == ""; i++ {
		before := map[string]int64{}
		for _, id := range b.ids {
			before[id] = *b.row(id).Allocated
		}
		b.pl.Plan(context.Background(), panel(b.ids...), []driver.ClientUsage{ // c1 runs, c2 idles
			reading("c1", b.counter["c1"]+40*quota.MB), reading("c2", b.counter["c2"])}, b.at)
		b.counter["c1"] += 40 * quota.MB
		b.row("c1").Counter = b.counter["c1"]
		b.s.grants[0].Used = b.counter["c1"] + b.counter["c2"]
		b.at = b.at.Add(time.Minute)
		for _, id := range b.ids {
			if a := *b.row(id).Allocated; a < before[id] {
				shrunk, was = id, before[id]
			}
		}
	}
	if shrunk == "" {
		t.Fatal("no share was shrunk in 20 turns of one config running")
	}
	c := b.row(shrunk)
	if !c.Pending || c.Peak == nil || *c.Peak != was {
		t.Fatalf("shrunk %s to %d: peak %v pending %v, want the old %d held and a write in flight",
			shrunk, *c.Allocated, c.Peak, c.Pending, was)
	}

	b.applied[shrunk], b.inflight[shrunk] = *c.Allocated, nil // the panel shows it
	b.turn(nil)
	if c := b.row(shrunk); c.Pending || *c.Peak != *c.Allocated {
		t.Fatalf("confirmed: peak %d pending %v, want the peak down to %d", *c.Peak, c.Pending, *c.Allocated)
	}
}

// A config no panel has read yet — a new purchase — gets its first share on
// the woken turn, before convergence looks for it; the rows are in lifetime
// bytes, so a config that served bytes before a counter restart carries them.
func TestANewConfigGetsItsFirstShareOnAWokenTurn(t *testing.T) {
	b := newBench(t, quota.GB, "c1")
	if err := b.pl.Allocate(context.Background(), panel("c1"), b.at); err != nil {
		t.Fatal(err)
	}
	c := b.row("c1")
	if c.Allocated == nil || *c.Allocated <= 0 || *c.Allocated > quota.GB {
		t.Fatalf("first share %v, want one inside the 1 GiB bag", c.Allocated)
	}
	if !c.Pending {
		t.Error("the first share is a write in flight until the panel shows it")
	}

	// A counter zeroed at 300 MiB served: the row's figure is the
	// planner's plus what the panel's counter no longer holds.
	o := newBench(t, quota.GB, "c1")
	oc := o.row("c1")
	oc.Exists, oc.Counter, oc.Offset = true, 0, 300*quota.MB
	o.s.grants[0].Used = 300 * quota.MB
	plans, err := o.pl.Plan(context.Background(), panel("c1"), []driver.ClientUsage{reading("c1", 0)}, o.at)
	if err != nil {
		t.Fatal(err)
	}
	if len(plans) != 1 || len(plans[0].Actions) != 1 {
		t.Fatalf("plans %+v, want one action", plans)
	}
	if got, want := *oc.Allocated, plans[0].Actions[0].Limit+300*quota.MB; got != want {
		t.Errorf("row holds %d, want the planner's %d plus the 300 MiB offset", got, plans[0].Actions[0].Limit)
	}
}

// A turn owes the panel a convergence only for what its plan left to carry
// (F-027-ds): an action, or a write still waiting to be read back. A panel
// already holding every figure is owed nothing, so a planned poll skips the
// whole-panel `ListClients` and the writes it would repeat.
func TestATurnOwesThePanelOnlyWhatThePlanMoved(t *testing.T) {
	b := newBench(t, quota.GB, "c1", "c2")
	owes := func() bool {
		t.Helper()
		var readings []driver.ClientUsage
		for _, id := range b.ids {
			readings = append(readings, reading(id, b.counter[id]))
		}
		owed, err := b.pl.Observe(context.Background(), panel(b.ids...), readings, b.at)
		if err != nil {
			t.Fatal(err)
		}
		b.at = b.at.Add(time.Minute)
		return owed
	}
	if !owes() {
		t.Fatal("the first shares were planned, and nothing was owed")
	}
	for i := 0; i < 8; i++ { // every write lands
		b.turn(nil)
	}
	for id, q := range b.inflight {
		if len(q) > 0 {
			t.Fatalf("%s still has %d write(s) in flight after 8 idle turns", id, len(q))
		}
	}
	if owes() {
		t.Fatal("a settled panel was owed a convergence")
	}

	// A shrink written and not yet shown: owed on every turn until it is.
	for i := 0; i < 20 && !b.row("c2").Pending && !b.row("c1").Pending; i++ {
		b.counter["c1"] += 40 * quota.MB
		b.row("c1").Counter = b.counter["c1"]
		b.s.grants[0].Used = b.counter["c1"] + b.counter["c2"]
		owes()
	}
	if !b.row("c2").Pending && !b.row("c1").Pending {
		t.Fatal("no write was left in flight in 20 turns of one config running")
	}
	if !owes() {
		t.Fatal("a write waiting on its read-back was owed nothing")
	}
}
