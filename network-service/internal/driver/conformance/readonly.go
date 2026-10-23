package conformance

import (
	"context"
	"testing"
	"time"

	"network-service/internal/driver"
	"network-service/internal/source"
)

// WriteCounter is what a family's harness adds for RunReadOnly: how many
// requests that change the far end it has served — anything but a read or
// the login, judged at the panel, as TotalCalls is.
type WriteCounter interface {
	WriteCalls() int
}

// RunReadOnly is the source-snapshot case (F-201-b, D-63): a reseller's old
// panel, read for an import, is never written to. Every family an import
// reads calls it beside Run. The snapshot is read-only by type
// (source.Reader); this proves the family's read methods are too — a read
// that logs in by creating something, or "repairs" a client it lists, is a
// write to a panel the reseller's users still depend on.
func RunReadOnly(t *testing.T, setup Setup) {
	t.Helper()
	t.Run("source_snapshot_writes_nothing", func(t *testing.T) {
		h, ok := sourceHarness(t, setup)
		if !ok {
			t.Fatal("an import source must take the pull, cumulative shape or, read in place (ADR-0160), a push one")
		}
		counter, ok := h.(WriteCounter)
		if !ok {
			t.Fatal("the harness does not count writes, so read-only cannot be proved")
		}
		h.Given("old-ali")
		h.Given("old-reza")
		h.Serve("old-ali", 1_000, 9_000)
		before := counter.WriteCalls()

		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		snap, err := source.Snapshot(ctx, h.Driver(), source.Limits{})
		if err != nil {
			t.Fatalf("Snapshot: %v", err)
		}
		if len(snap.Clients) != 2 {
			t.Fatalf("the snapshot holds %d clients, want 2", len(snap.Clients))
		}
		batch := make([]source.LinkRequest, 0, len(snap.Clients))
		for _, c := range snap.Clients {
			batch = append(batch, source.LinkRequest{RemoteID: c.RemoteID, UUID: c.UUID, Label: c.Label, InboundRemoteID: c.InboundRemoteID})
		}
		if _, err := source.Links(ctx, h.Driver(), batch); err != nil {
			t.Fatalf("Links: %v", err)
		}
		if got := counter.WriteCalls() - before; got != 0 {
			t.Fatalf("reading the source made %d write call(s) to it", got)
		}
	})
}

// sourceHarness is the family's harness in the shape it is read in: an Xray
// panel pulled with cumulative counters, or a RADIUS panel (User Manager,
// F-1601-a) whose users are imported in place and whose NAS pushes sessions.
func sourceHarness(t *testing.T, setup Setup) (Harness, bool) {
	for _, shape := range []Shape{pull(driver.CounterCumulative), push(true), push(false)} {
		if h, ok := setup(t, shape); ok {
			return h, true
		}
	}
	return nil, false
}
