package leaseplan_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"network-service/internal/driver"
	"network-service/internal/lease/quota"
	"network-service/internal/leaseplan"
)

// A metered Grant under the planner (F-027-dc, ADR-0093): the planner hands
// out Quota — the bag plus what the wallet would still buy — and asks billing
// for a block when what was actually bought runs out inside a horizon. The
// planner sees the counter, so it is the one that knows when; billing keeps
// the money and decides whether.

type requests struct {
	mu   sync.Mutex
	sent []leaseplan.BlockRequest
	fail error
}

func (r *requests) RequestBlock(_ context.Context, req leaseplan.BlockRequest) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.fail != nil {
		return r.fail
	}
	r.sent = append(r.sent, req)
	return nil
}

// meteredBench is one metered Grant on one panel, one config at 100 Mbit:
// purchased bytes of bag, and a wallet reserve on top of it in Quota.
type meteredBench struct {
	t       *testing.T
	s       *store
	req     *requests
	pl      *leaseplan.Planner
	counter int64
	at      time.Time
}

const lineRate = 12_500_000 // 100 Mbit, in bytes a second

func newMetered(t *testing.T, purchased, reserve int64) *meteredBench {
	b := &meteredBench{t: t, s: newStore(), req: &requests{}, at: time.Date(2026, 9, 27, 10, 0, 0, 0, time.UTC)}
	b.pl = &leaseplan.Planner{Store: b.s, Blocks: b.req}
	b.s.grants = []leaseplan.Grant{{ID: "grant-1", Metered: true, Purchased: purchased, Quota: purchased + reserve,
		Configs: []leaseplan.Config{{ID: "config-c1", PanelID: panelID, Exists: true, Enabled: true}}}}
	return b
}

// turn serves `seconds` of line rate and runs one collection turn.
func (b *meteredBench) turn(seconds int) {
	b.t.Helper()
	b.counter += int64(seconds) * lineRate
	b.at = b.at.Add(time.Duration(seconds) * time.Second)
	g := &b.s.grants[0]
	g.Used, g.Configs[0].Counter = b.counter, b.counter
	if _, err := b.pl.Plan(context.Background(), panel("c1"), []driver.ClientUsage{reading("c1", b.counter)}, b.at); err != nil {
		b.t.Fatal(err)
	}
}

func (b *meteredBench) buy(bytes int64) {
	g := &b.s.grants[0]
	g.Purchased += bytes
	g.Quota += bytes
}

func TestABagRunningOutInsideTheHorizonAsksBillingForABlock(t *testing.T) {
	b := newMetered(t, 400*quota.MB, 10*quota.GB)
	for i := 0; i < 4 && len(b.req.sent) == 0; i++ {
		b.turn(5)
	}
	if len(b.req.sent) != 1 {
		t.Fatalf("want one request once the bag is inside the horizon, got %d", len(b.req.sent))
	}
	r := b.req.sent[0]
	if r.GrantID != "grant-1" || r.PurchasedBytes != 400*quota.MB {
		t.Fatalf("the request names the Grant and the bag it saw: %+v", r)
	}
	headroom := 400*quota.MB - b.counter
	horizon := int64(quota.DefaultParams().Horizon.Seconds())
	if r.RateBps <= 0 || r.TargetBytes != r.RateBps/8*horizon-headroom {
		t.Fatalf("target is a horizon of the measured rate less the headroom: %+v, headroom %d", r, headroom)
	}
	if !r.RequestedAt.Equal(b.at) {
		t.Fatalf("stamped with the turn's clock, got %s", r.RequestedAt)
	}
}

func TestOneBagIsAskedForOnceUntilItMovesOrTheRetryIsDue(t *testing.T) {
	b := newMetered(t, 400*quota.MB, 10*quota.GB)
	for range 4 {
		b.turn(5)
	}
	b.turn(5)
	if len(b.req.sent) != 1 {
		t.Fatalf("the same bag inside the retry window is not asked for twice, got %d", len(b.req.sent))
	}
	b.buy(4 * quota.GB)
	b.turn(5)
	if len(b.req.sent) != 1 {
		t.Fatalf("a bag bought past the horizon asks for nothing, got %d", len(b.req.sent))
	}
	for range 40 {
		b.turn(5)
	}
	if len(b.req.sent) < 2 || b.req.sent[1].PurchasedBytes != 400*quota.MB+4*quota.GB {
		t.Fatalf("a bag that moved is asked for again when it nears its end: %+v", b.req.sent)
	}
	n := len(b.req.sent)
	b.turn(int(leaseplan.BlockRetry.Seconds()) + 1)
	if len(b.req.sent) != n+1 {
		t.Fatalf("an unanswered request is repeated once the retry is due, got %d after %d", len(b.req.sent), n)
	}
}

func TestAPrepaidGrantNeverAsksAndAPlentifulBagWaits(t *testing.T) {
	b := newMetered(t, 400*quota.MB, 0)
	b.s.grants[0].Metered = false
	for range 4 {
		b.turn(5)
	}
	if len(b.req.sent) != 0 {
		t.Fatalf("a prepaid bag is fixed at purchase: %+v", b.req.sent)
	}
	b = newMetered(t, 50*quota.GB, 10*quota.GB)
	for range 4 {
		b.turn(5)
	}
	if len(b.req.sent) != 0 {
		t.Fatalf("a bag an hour from its end asks for nothing: %+v", b.req.sent)
	}
}

func TestARequestThatDidNotLeaveIsTriedOnTheNextTurn(t *testing.T) {
	b := newMetered(t, 400*quota.MB, 10*quota.GB)
	b.req.fail = errors.New("broker down")
	for range 4 {
		b.turn(5)
	}
	b.req.fail = nil
	b.turn(5)
	if len(b.req.sent) != 1 {
		t.Fatalf("a failed publish is not throttled: want the next turn to send it, got %d", len(b.req.sent))
	}
}

// The reserve is part of Quota, so the planner leases past the bag: a
// metered user is not cut at the end of a block billing has not bought yet.
func TestTheReserveIsLeasedPastTheBag(t *testing.T) {
	b := newMetered(t, 10*quota.MB, 10*quota.GB)
	b.turn(5)
	b.turn(5)
	a := b.s.grants[0].Configs[0].Allocated
	if a == nil || *a <= 10*quota.MB+b.counter {
		t.Fatalf("want a lease past the 10 MB bag, from the reserve; got %v (served %d)", a, b.counter)
	}
}

func TestTheReserveIsWhatTheWalletBuys(t *testing.T) {
	cases := []struct {
		rate, balance string
		want          int64
	}{
		{"0.50000000", "5.00", 10 * quota.GB},
		{"0.50000000", "0.004", 0},
		{"", "5.00", 0},
		{"0.50000000", "", 0},
	}
	for _, c := range cases {
		if got := leaseplan.BytesAffordable(c.rate, c.balance); got != c.want {
			t.Errorf("BytesAffordable(%q, %q) = %d, want %d", c.rate, c.balance, got, c.want)
		}
	}
}

// One wallet, one reserve (F-027-dt): an owner's metered Grants split the
// balance's cents evenly, each converting its share at its own rate, so the
// shares together never buy past the wallet.
func TestAnOwnersMeteredGrantsSplitOneReserve(t *testing.T) {
	cases := []struct {
		rate, balance string
		grants        int64
		want          int64
	}{
		{"0.50000000", "5.00", 1, 10 * quota.GB},
		{"0.50000000", "5.00", 2, 5 * quota.GB},
		{"1.00000000", "5.00", 2, 5 * quota.GB / 2},
		{"1.00000000", "0.10", 3, 3 * quota.GB / 100}, // 10 cents over 3 is 3 each, floored
		{"1.00000000", "0.02", 3, 0},                  // under a cent each buys nothing
		{"0.50000000", "5.00", 0, 10 * quota.GB},      // no count read is the Grant alone
	}
	for _, c := range cases {
		if got := leaseplan.ReserveShare(c.rate, c.balance, c.grants); got != c.want {
			t.Errorf("ReserveShare(%q, %q, %d) = %d, want %d", c.rate, c.balance, c.grants, got, c.want)
		}
	}
}
