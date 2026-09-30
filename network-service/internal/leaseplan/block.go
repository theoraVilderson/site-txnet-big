package leaseplan

import (
	"context"
	"math"
	"math/big"
	"time"
)

// A metered Grant under the planner (F-027-dc, ADR-0093 amendment
// 2026-09-27). Billing keeps the money and the planner sees the counter, so
// the planner says when a block is due and billing decides whether it is
// bought (`contract.lease.md` "A metered Grant").

// BlockRetry is how long one bag is asked for once. A request billing
// dropped or refused — a short wallet, a lost race — is repeated after it
// while the bag is still inside the horizon; one that was bought moves the
// bag, and the next request is for the new one.
const BlockRetry = 30 * time.Second

// WholesaleRetry replaces BlockRetry for a Grant whose reseller's billing
// wallet funds nothing past its bag on a platform panel (F-118-w): billing
// can only refuse it `wholesale_unfunded`, and tells the reseller once. It is
// still asked, this seldom, because billing's platform test (the group holds
// a platform panel) is not the planner's (a live config on one). A top-up
// gives the Grant room again, and the next pass is back on BlockRetry.
const WholesaleRetry = 10 * time.Minute

// BlockRequest asks billing for the next block of a metered Grant
// (`contracts/network/block-request.json`). PurchasedBytes is the bag the
// planner saw: billing buys only while the Grant still holds that figure, so
// a request that arrives after another block was bought is dropped, never
// bought twice.
type BlockRequest struct {
	GrantID        string
	PurchasedBytes int64
	// TargetBytes is a horizon of the Grant's measured rate, less what is
	// left of the bag (a negative headroom makes it larger: the overrun is
	// bought with it). Billing floors it at its own minimum block.
	TargetBytes int64
	// RateBps is the rate the target was sized at, in bits a second.
	RateBps     int64
	RequestedAt time.Time
}

// BlockRequester carries a request to billing — `publish.BlockRequests` in a
// running process. A nil one on the Planner asks for nothing.
type BlockRequester interface {
	RequestBlock(ctx context.Context, req BlockRequest) error
}

// asked is the last request sent for one Grant.
type asked struct {
	purchased int64
	at        time.Time
}

// blockDue is the request a metered Grant's plan calls for, if any: the bag
// actually bought — Quota less the reserve — runs out inside the horizon at
// the Grant's current rate. A spent bag is inside it at any speed; a Grant
// with no rate is not, unless it is already past its bag, and then only the
// overrun is asked for. rateNow is the trigger's rate (the planner's own
// tEnd reads the fast one), rateDemand the size's.
func blockDue(g Grant, rateNow, rateDemand float64, horizon time.Duration, at time.Time, reopen int64) (BlockRequest, bool) {
	if !g.Metered {
		return BlockRequest{}, false
	}
	headroom := g.Purchased - g.Used
	tEnd := math.Inf(1)
	switch {
	case headroom <= 0, headroom < reopen:
		tEnd = 0
	case rateNow > 0:
		tEnd = float64(headroom) / rateNow
	}
	if tEnd >= horizon.Seconds() {
		return BlockRequest{}, false
	}
	perSecond := int64(rateDemand)
	target := max(perSecond*int64(horizon.Seconds()), reopen) - headroom
	if target <= 0 {
		return BlockRequest{}, false
	}
	return BlockRequest{GrantID: g.ID, PurchasedBytes: g.Purchased, TargetBytes: target, RateBps: perSecond * 8,
		RequestedAt: at}, true
}

// gib is the byte count one unit of a `vpn.traffic` meter's `unitPrice` prices (ADR-0073).
var gib = big.NewRat(1<<30, 1)

// BytesAffordable is what an amount of money buys at a metered rate: whole
// cents of it, floored, over the rate per 2^30 bytes, floored — billing's
// `bytesAffordable`, held to the same figures by
// `contracts/network/block-request.json`. The planner reads a Grant's
// reserve through it: the amount is its open reserve hold (F-118-b), so what
// it leases past the bag is money no other debit can spend. Both are the
// columns' decimal text (`grant_meter.unitPrice` Decimal(18,8),
// `wallet_hold.amount` Decimal(18,2)), never a float (C-02). No rate, no
// amount, a rate of zero or an amount under a cent buys nothing; a figure
// past int64 is capped.
func BytesAffordable(rate, amount string) int64 {
	return unitsAffordable(rate, amount, gib)
}

// unitsAffordable is whole cents of amount, floored, over price per unit
// units, floored — billing's `unitsCovered(rate, toCents(amount))`.
func unitsAffordable(price, amount string, unit *big.Rat) int64 {
	r, ok := new(big.Rat).SetString(price)
	if !ok || r.Sign() <= 0 {
		return 0
	}
	b, ok := new(big.Rat).SetString(amount)
	if !ok || b.Sign() <= 0 {
		return 0
	}
	cents := floor(new(big.Rat).Mul(b, big.NewRat(100, 1)))
	if cents.Sign() <= 0 {
		return 0
	}
	// cents × unit / (100 × price)
	q := new(big.Rat).Mul(new(big.Rat).SetInt(cents), unit)
	q.Quo(q, new(big.Rat).Mul(r, big.NewRat(100, 1)))
	n := floor(q)
	if !n.IsInt64() {
		return math.MaxInt64
	}
	return n.Int64()
}

// Wholesale is a reseller's side of a metered Grant (F-118-n3): its
// `vpn.traffic` meter's locked wholesale rate and cursors, and the payer's
// `tenant_billing_wallet.cachedBalance` — decimal text, never a float (C-02).
type Wholesale struct {
	UnitSize  int64
	UnitPrice string
	Balance   string
	Billed    int64 // `wholesaleBilled`
	Consumed  int64 // `wholesaleConsumed`, bytes served on platform panels
}

// WholesaleRoom is how far past the bag the reseller's billing wallet funds a
// Grant (F-118-v): every byte the balance buys past its cursor, less what the
// cursor already owes for the bag's unserved part — billing's
// `VpnWholesale.room`, the bound a block is sized under. purchased and
// consumed are the Grant's own columns, so the lag they share with
// `wholesaleConsumed` cancels. Never negative: a reseller behind its cursor
// funds nothing more, and the bag it already bought stands.
func WholesaleRoom(w Wholesale, purchased, consumed int64) int64 {
	reach := w.Billed + unitsAffordable(w.UnitPrice, w.Balance, big.NewRat(w.UnitSize, 1))
	if reach < w.Billed { // capped at MaxInt64 above
		return math.MaxInt64
	}
	return max(reach-w.Consumed-(purchased-consumed), 0)
}

// ReserveBytes is what the planner leases past the bag (F-027-dc): what the
// user's reserve buys, bounded on a platform panel by what the reseller's
// wallet funds (F-118-v) — the lesser of the two. nil is no wholesale bound.
func ReserveBytes(user int64, wholesale *int64) int64 {
	if wholesale == nil {
		return user
	}
	return min(user, *wholesale)
}

func floor(r *big.Rat) *big.Int {
	return new(big.Int).Quo(r.Num(), r.Denom()) // both positive here: Quo truncates toward zero
}
