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

// A closed metered Grant still asks for its spent bag (F-118-ad, rule 21):
// the reserve it served past the bag is bought with it, and billing's
// refusal is the only thing that suspends it. Seen live on 2026-09-30: a
// Grant served its 30 MB reserve and 20 MB past it, closed, and asked for
// nothing — the reserve was never charged and the Grant read `active`.
func TestAClosedMeteredGrantStillAsksForItsSpentBag(t *testing.T) {
	b := newMetered(t, 0, 30*quota.MB)
	b.turn(5)
	if len(b.req.sent) != 1 {
		t.Fatalf("a Grant closed past its bag asks for the overrun, got %d requests", len(b.req.sent))
	}
	if r := b.req.sent[0]; r.PurchasedBytes != 0 || r.TargetBytes < b.counter {
		t.Fatalf("the request covers what was served past the bag: %+v, served %d", r, b.counter)
	}
	b.turn(int(leaseplan.BlockRetry.Seconds()) + 1)
	if len(b.req.sent) != 2 {
		t.Fatalf("it is asked again every retry until billing answers, got %d", len(b.req.sent))
	}
}

// A close with bytes still in the bag and nothing moving asks for nothing:
// rule 21's "no rate and bytes left is not due" holds for a closed account.
func TestAClosedGrantWithBytesLeftAndNoRateAsksNothing(t *testing.T) {
	b := newMetered(t, 400*quota.MB, 0)
	b.s.grants[0].ExpiresAt = b.at.Add(time.Minute)
	b.turn(1)
	n := len(b.req.sent)
	b.turn(0)
	b.at = b.at.Add(2 * time.Minute)
	b.turn(0)
	b.turn(int(leaseplan.BlockRetry.Seconds()) + 1)
	if len(b.req.sent) != n {
		t.Fatalf("an expired close with bytes left and no traffic asks for no block: %+v", b.req.sent[n:])
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

// A reseller's metered Grant on a platform panel (F-118-v, ADR-0094 amendment
// 2026-09-29): the reserve is leased only as far as the reseller's billing
// wallet also funds it — billing's `VpnWholesale.room`, the same figure a
// block is bounded by. Its cursor already covers the bag; what the balance
// buys at the wholesale rate is the rest.
func TestTheResellerWalletBoundsTheReserve(t *testing.T) {
	gb := int64(quota.GB)
	cases := []struct {
		name                string
		w                   leaseplan.Wholesale
		purchased, consumed int64
		want                int64
	}{
		// $1 at $1 per GiB buys one GiB past a cursor that covers the bag exactly.
		{"a dollar buys a gigabyte", leaseplan.Wholesale{UnitSize: 1 << 30, UnitPrice: "1.00000000", Balance: "1.00", Billed: 3 << 30, Consumed: 1 << 30}, 3 << 30, 1 << 30, 1 << 30},
		// Bytes an own panel served funded nothing wholesale: the cursor is ahead by them.
		{"an own panel's bytes fund the next", leaseplan.Wholesale{UnitSize: 1 << 30, UnitPrice: "1.00000000", Balance: "0.00", Billed: 3 << 30, Consumed: 1 << 30}, 3 << 30, 2 << 30, 1 << 30},
		{"a reseller at zero adds nothing", leaseplan.Wholesale{UnitSize: 1 << 30, UnitPrice: "1.00000000", Balance: "0.00", Billed: 3 << 30, Consumed: 1 << 30}, 3 << 30, 1 << 30, 0},
		{"a reseller behind its cursor adds nothing", leaseplan.Wholesale{UnitSize: 1 << 30, UnitPrice: "1.00000000", Balance: "0.50", Billed: 1 << 30, Consumed: 3 << 30}, 3 << 30, 1 << 30, 0},
		{"a unit priced per MiB", leaseplan.Wholesale{UnitSize: 1 << 20, UnitPrice: "0.00100000", Balance: "0.01", Billed: 0, Consumed: 0}, 0, 0, 10 << 20},
		{"an unpriceable rate adds nothing", leaseplan.Wholesale{UnitSize: 1 << 30, UnitPrice: "0", Balance: "9.00", Billed: 0, Consumed: 0}, 0, 0, 0},
	}
	for _, c := range cases {
		if got := leaseplan.WholesaleRoom(c.w, c.purchased, c.consumed); got != c.want {
			t.Errorf("%s: WholesaleRoom = %d, want %d (%.2f GB)", c.name, got, c.want, float64(c.want)/float64(gb))
		}
	}
	// The lesser of the two wallets: $5 of the user's, $1 of the reseller's.
	if got := leaseplan.ReserveBytes(5*gb, ptr(1*gb)); got != 1*gb {
		t.Errorf("ReserveBytes(5 GB, 1 GB) = %d, want 1 GB", got)
	}
	if got := leaseplan.ReserveBytes(5*gb, nil); got != 5*gb {
		t.Errorf("ReserveBytes(5 GB, no leg) = %d, want 5 GB", got)
	}
}

func ptr(v int64) *int64 { return &v }

// A reseller at zero (F-118-w): billing can only refuse its platform Grant's
// block `wholesale_unfunded`, and tells the reseller once, so the planner asks
// for that bag every WholesaleRetry, not every BlockRetry — and is back on
// BlockRetry the pass a top-up gives the Grant room again.
// The reserve keeps the Grant open here, so only the retry is tested: in a
// running planner an unfunded Grant's Quota is its bag, and a close at it
// asks for nothing until a top-up grows Quota and reopens it.
func TestAResellerAtZeroIsAskedForSeldom(t *testing.T) {
	b := newMetered(t, 400*quota.MB, 10*quota.GB)
	b.s.grants[0].Unfunded = true
	for range 4 {
		b.turn(5)
	}
	if len(b.req.sent) != 1 {
		t.Fatalf("an unfunded Grant's bag is still asked for once, got %d", len(b.req.sent))
	}
	b.turn(int(leaseplan.BlockRetry.Seconds()) + 1)
	if len(b.req.sent) != 1 {
		t.Fatalf("not again when BlockRetry is due, got %d", len(b.req.sent))
	}
	b.turn(int(leaseplan.WholesaleRetry.Seconds()))
	if len(b.req.sent) != 2 {
		t.Fatalf("again once WholesaleRetry is due, got %d", len(b.req.sent))
	}
	b.s.grants[0].Unfunded = false
	b.turn(int(leaseplan.BlockRetry.Seconds()) + 1)
	if len(b.req.sent) != 3 {
		t.Fatalf("a funded reseller is back on BlockRetry at once, got %d", len(b.req.sent))
	}
}
