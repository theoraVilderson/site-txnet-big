package conformance

import (
	"context"
	"fmt"
	"testing"
	"time"

	"network-service/internal/driver"
)

// Request volume (F-027-k).
//
// The four scenarios below count requests at the far end. They are the
// mechanised form of catalog 8.4: a driver that reads client-by-client is a
// 1000 req/s flood on a customer's own server, and it is an ordinary-looking
// driver that passes every scenario in conformance.go.
//
// The first two are the family's own obligation, and are asserted against the
// driver exactly as its test supplied it. The last two are driver.Pace's, the
// shared layer every family is wrapped in (F-027-v wires its numbers to the
// panel row): they are asserted here rather than in a unit test of their own
// because what has to hold is "this family, paced, asks once" — a property of
// the pair, which a test of the wrapper alone cannot see.

// bulkPassIsBounded: the whole panel costs a bounded number of requests — one,
// or one per page of at least driver.MinPageSize clients (ADR-0081). Five
// thousand is the figure the questionnaire's refusal names, and the reason
// bulk_usage_in_one_call is a `required` row: a family that reads client by
// client would make every collection pass 5000 requests on someone else's
// server. Fifty pages of a hundred is a different thing, and each of them is
// paid for in the panel's budget (driver.NextPage).
func bulkPassIsBounded(t *testing.T, h Harness, _ Shape) {
	const clients = 5_000
	for i := 0; i < clients; i++ {
		h.Given(fmt.Sprintf("c%d", i))
	}

	before := h.TotalCalls()
	readings, err := h.Driver().GetUsage(context.Background())
	if err != nil {
		t.Fatalf("GetUsage over %d clients: %v", clients, err)
	}
	most := (clients + driver.MinPageSize - 1) / driver.MinPageSize
	if got := h.TotalCalls() - before; got > most {
		t.Errorf("a bulk pass over %d clients cost %d requests, want at most %d (pages of %d or more): "+
			"per-client reads are the flood catalog 8.4 forbids", clients, got, most, driver.MinPageSize)
	}
	if len(readings) != clients {
		t.Errorf("the bulk pass returned %d readings of %d clients: a paged read that stops early "+
			"is a pass that silently misses users", len(readings), clients)
	}
}

// hotPassIsOneCall: the hot loop reads the few configs near their ceiling
// every few seconds (F-027-u), so its cost is the one that multiplies. One
// request per panel is the contract whether the family has a subset endpoint
// or serves the subset from its bulk call — the loop reads the declared answer
// to size its interval, never the shape of the implementation. A family whose
// bulk read is paged therefore needs a subset endpoint: served from fifty
// pages, the hot pass would be fifty requests every few seconds (ADR-0081).
func hotPassIsOneCall(t *testing.T, h Harness, _ Shape) {
	const clients, hot = 5_000, 12
	for i := 0; i < clients; i++ {
		h.Given(fmt.Sprintf("c%d", i))
	}
	wanted := make([]string, 0, hot)
	for i := 0; i < hot; i++ {
		wanted = append(wanted, fmt.Sprintf("c%d", i*7))
	}

	before := h.TotalCalls()
	readings, err := h.Driver().GetUsageFor(context.Background(), wanted)
	if err != nil {
		t.Fatalf("GetUsageFor %d of %d clients: %v", hot, clients, err)
	}
	if got, want := h.TotalCalls()-before, perRead(h); got != want {
		t.Errorf("a hot pass over %d clients cost %d requests, want exactly %d per panel: "+
			"at the hot loop's interval, one request per client is the flood arriving faster", hot, got, want)
	}

	got := map[string]bool{}
	for _, r := range readings {
		got[r.RemoteID] = true
	}
	for _, id := range wanted {
		if !got[id] {
			t.Errorf("the hot pass did not return %s, which it was asked for", id)
		}
	}
	if len(readings) != hot {
		t.Errorf("the hot pass returned %d readings for %d named clients: a subset call that answers "+
			"with the whole panel is the bulk call wearing the hot loop's name", len(readings), hot)
	}
}

// singleFlightUnderASlowPanel: while one whole-panel read is in the air, every
// other caller that wants the same read joins it instead of opening a second.
// A slow panel is exactly when this matters — that is when the callers pile up
// — and a panel answering in 8s at a 2s interval is where a collector turns
// into its own denial of service.
//
// It is single-flight, not a cache: a caller arriving after the flight has
// landed gets a fresh read. Bytes are money, and a reading served from memory
// is a figure nobody measured at the moment it was used.
func singleFlightUnderASlowPanel(t *testing.T, h Harness, _ Shape) {
	h.Given("c1")
	h.Serve("c1", 10, 20)

	d := driver.Pace(h.Driver(), driver.Budget{MaxRequests: 100, Window: time.Minute})
	const callers = 4
	const stall = 300 * time.Millisecond

	before := h.TotalCalls()
	h.StallNextCall(stall)

	type result struct {
		readings []driver.ClientUsage
		err      error
	}
	results := make(chan result, callers)
	go func() {
		readings, err := d.GetUsage(context.Background())
		results <- result{readings, err}
	}()

	// The joiners must arrive while the leader's call is still in the air, so
	// they are launched once the far end reports having it.
	waitUntil(t, "the leader's call reached the far end", func() bool {
		return h.TotalCalls() == before+1
	})
	for i := 1; i < callers; i++ {
		go func() {
			readings, err := d.GetUsage(context.Background())
			results <- result{readings, err}
		}()
	}

	for i := 0; i < callers; i++ {
		got := <-results
		if got.err != nil {
			t.Fatalf("caller %d: %v", i, got.err)
		}
		if len(got.readings) != 1 || !readsAs(got.readings[0], 10, 20) {
			t.Errorf("caller %d got %+v, want the one reading of 10/20 that the flight read", i, got.readings)
		}
	}
	if got, want := h.TotalCalls()-before, perRead(h); got != want {
		t.Errorf("%d concurrent whole-panel reads cost %d requests, want %d: the callers did not share "+
			"the flight, and a slow panel multiplies that by however many are waiting", callers, got, want)
	}

	if _, err := d.GetUsage(context.Background()); err != nil {
		t.Fatalf("the read after the flight: %v", err)
	}
	if got, want := h.TotalCalls()-before, 2*perRead(h); got != want {
		t.Errorf("the read after the flight landed cost %d requests in total, want %d: single-flight "+
			"served it from memory, and a reading nobody measured is being billed", got, want)
	}
}

// requestBudgetIsNeverExceeded: the panel's own `maxRequestsPerMinute` is a
// ceiling on us, not a hope. Over it is a 429 at best and a ban at worst
// (F-027-v), so a call that would cross it waits for its slot rather than
// being dropped — a dropped read is a gap in the counter, which is invariant
// 18's failure arriving through the remedy.
//
// The window is compressed here; the arithmetic is the one a minute uses.
func requestBudgetIsNeverExceeded(t *testing.T, h Harness, _ Shape) {
	h.Given("c1")

	const window = 200 * time.Millisecond
	const budget = 2
	const calls = 6
	d := driver.Pace(h.Driver(), driver.Budget{MaxRequests: budget, Window: window})

	before := h.TotalCalls()
	started := time.Now()
	for i := 0; i < calls; i++ {
		if _, err := d.GetUsage(context.Background()); err != nil {
			t.Fatalf("call %d: %v", i, err)
		}
		// Call i may not be served before its window opens: the first `budget`
		// go at once, the next `budget` a window later, and so on.
		if earliest := time.Duration(i/budget) * window; time.Since(started) < earliest {
			t.Errorf("call %d was served after %s, before its window opened at %s: the panel was asked "+
				"more than %d times in %s", i, time.Since(started), earliest, budget, window)
		}
	}

	if got, want := h.TotalCalls()-before, calls*perRead(h); got != want {
		t.Errorf("%d calls reached the far end as %d requests, want all %d: the budget delays a "+
			"read, it never drops one — a dropped read is a hole in the counter", calls, got, want)
	}
}

// ReadCost is a harness whose family reads usage in a fixed number of
// requests more than one, whatever the number of clients: User Manager's
// users' ids, then one monitor over them (F-027-ag-b). Each request past the
// first is a page the read pays for (driver.NextPage, ADR-0081). A harness
// without it reads in one, and the scenarios that count to the request hold
// a family to its own figure — a constant, never one per client.
type ReadCost interface {
	RequestsPerRead() int
}

// perRead is the requests one usage read costs on h's family.
func perRead(h Harness) int {
	if c, ok := h.(ReadCost); ok {
		return c.RequestsPerRead()
	}
	return 1
}
