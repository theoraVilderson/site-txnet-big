package fake_test

import (
	"context"
	"testing"

	"network-service/internal/driver"
	"network-service/internal/driver/conformance"
	"network-service/internal/driver/fake"
)

// The invariant this row turns on: every pipeline above the driver is built
// and proved against a source that can reset, stall, wrap at 32 bits, omit
// Gigawords, drop a Stop and refuse a ceiling — before we own a single server
// (ADR-0074). The fake is that source, and the suite is what "conforms" means.

func TestFakePanelPassesTheConformanceSuite(t *testing.T) {
	conformance.Run(t, func(t *testing.T, shape conformance.Shape) (conformance.Harness, bool) {
		unsupported := map[driver.RowKey]bool{}
		if !shape.CeilingSupported {
			unsupported[driver.RowPerClientDataLimit] = true
		}
		if !shape.GigawordsReported {
			unsupported[driver.RowGigawordsReported] = true
		}
		return fake.New(fake.Config{
			Transport:        shape.Transport,
			CounterSemantics: shape.CounterSemantics,
			Unsupported:      unsupported,
		}), true
	})
}

// A fake whose answers the real registration path would refuse proves nothing
// about the pipeline built on it, so the document it writes is held to the
// same Validate and Verdict as a real panel's (F-027-i).
func TestFakeAnswersADocumentRegistrationAccepts(t *testing.T) {
	for _, tc := range []struct {
		name      string
		config    fake.Config
		wantState driver.ReviewState
	}{
		{"pull cumulative", fake.Config{Transport: driver.TransportPull, CounterSemantics: driver.CounterCumulative}, driver.ReviewAccepted},
		{"push session", fake.Config{Transport: driver.TransportPush, CounterSemantics: driver.CounterSession}, driver.ReviewAccepted},
		{"pull reset_on_read", fake.Config{Transport: driver.TransportPull, CounterSemantics: driver.CounterResetOnRead}, driver.ReviewAcceptedLowTrust},
	} {
		t.Run(tc.name, func(t *testing.T) {
			caps, err := fake.New(tc.config).Capabilities(context.Background())
			if err != nil {
				t.Fatalf("Capabilities: %v", err)
			}
			if err := caps.Validate(tc.config.Transport); err != nil {
				t.Fatalf("the fake wrote a document the column would refuse: %v", err)
			}
			if got := caps.Verdict(tc.config.Transport, tc.config.CounterSemantics); got.ReviewState != tc.wantState {
				t.Errorf("reviewState = %s, want %s (unmet: %v)", got.ReviewState, tc.wantState, got.Unmet)
			}
		})
	}
}

// reset_on_read is the one semantics whose reading destroys its source: the
// second read of the same traffic is zero, and a publish that fails between
// them has lost those bytes permanently. The fake has to lose them too, or the
// low-trust marking it is accepted under is a claim nothing exercises.
func TestResetOnReadIsZeroedByBeingRead(t *testing.T) {
	panel := fake.New(fake.Config{Transport: driver.TransportPull, CounterSemantics: driver.CounterResetOnRead})
	panel.Given("c1")
	panel.Serve("c1", 100, 900)

	first, err := panel.GetUsage(context.Background())
	if err != nil {
		t.Fatalf("GetUsage: %v", err)
	}
	if len(first) != 1 || first[0].DownBytes != 900 {
		t.Fatalf("first read = %+v, want one reading of 900 down", first)
	}
	second, err := panel.GetUsage(context.Background())
	if err != nil {
		t.Fatalf("GetUsage: %v", err)
	}
	if len(second) != 1 || second[0].UpBytes != 0 || second[0].DownBytes != 0 {
		t.Errorf("second read = %+v, want zeroes: a reset_on_read counter is spent by the read", second)
	}
}
