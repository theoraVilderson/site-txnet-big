// Package conformance is the suite every driver passes before it carries a
// user (F-027-j, ADR-0074).
//
// A wrong declaration is a silent wrong number, not a crash, so the eleven
// scenarios below are the ones where a driver can be plausibly wrong: a
// counter that resets, a panel restored from backup, a call that stalls past
// its deadline, a figure nobody could have served, a session that never says
// Stop, a NAS that omits Gigawords, a 32-bit counter crossing 4 GB, a ceiling
// refused, a ceiling applied late, and a 429 that is not a 5xx.
//
// The suite asserts the *driver* contract, not the pipeline's: a driver reports
// what the far end said and classifies why a call failed. It never repairs a
// reset, clamps an implausible figure or extrapolates past a missing Stop —
// those are the normaliser's (F-027-l), and a driver that did them would hide
// the evidence the normaliser decides on.
package conformance

import (
	"context"
	"errors"
	"testing"
	"time"

	"network-service/internal/driver"
)

// Scenario names one case. The list is closed and ordered: a family that
// cannot be put into a scenario's shape skips it, and a family that skips one
// silently is a family whose gap nobody can see, so every skip is reported.
type Scenario string

const (
	ScenarioCounterReset       Scenario = "counter_reset"
	ScenarioBackupRestore      Scenario = "backup_restore"
	ScenarioTimeout            Scenario = "timeout"
	ScenarioSlowReply          Scenario = "slow_reply"
	ScenarioImplausibleFigure  Scenario = "implausible_figure"
	ScenarioSessionWithoutStop Scenario = "session_without_stop"
	ScenarioMissingGigawords   Scenario = "missing_gigawords"
	ScenarioCounterWrap        Scenario = "thirty_two_bit_wrap"
	ScenarioCeilingRefused     Scenario = "ceiling_refused"
	ScenarioCeilingAppliedLate Scenario = "ceiling_applied_late"
	ScenarioRateLimitedVsFault Scenario = "rate_limited_vs_server_fault"
)

// Shape is the panel a scenario needs. A driver's Setup builds one or says it
// cannot: a real family whose panel always reports Gigawords is not asked to
// pretend otherwise, and the scenario is skipped by name rather than passed
// by default.
type Shape struct {
	Transport         driver.Transport
	CounterSemantics  driver.CounterSemantics
	CeilingSupported  bool
	GigawordsReported bool
}

// Harness is what a driver's own test provides: the driver under test, plus
// the far end it speaks to, scripted. The fake driver's harness is the fake
// panel itself; a real driver's harness drives a scripted HTTP server of its
// family (F-027-ae). Nothing here reaches through the driver — every
// assertion below goes through the Driver interface.
type Harness interface {
	Driver() driver.Driver

	// Given puts a client on the panel without going through the driver, so a
	// scenario starts from a panel that already has users on it.
	Given(remoteID string)
	// Serve moves bytes at the far end.
	Serve(remoteID string, up, down int64)
	// ZeroCounter is the far end losing its counter: a restart, an operator
	// reset, or a client update on a panel whose counter does not survive one.
	ZeroCounter(remoteID string)

	// TakeBackup and RestoreBackup are ADR-0074's catastrophe, in two halves.
	TakeBackup()
	RestoreBackup()

	// StallNextCall makes the next call take this long before it replies.
	StallNextCall(d time.Duration)
	// FailNextCall makes the next call fail with this HTTP status.
	FailNextCall(status int)

	// AbandonSession leaves a session open and un-updated — the NAS that never
	// sent a Stop. Bytes served afterwards are not reported.
	AbandonSession(remoteID string)
	// DelayCeilingBy accepts the next ceiling write and reflects it at the far
	// end only after this many reads.
	DelayCeilingBy(reads int)
}

// Setup builds a harness in the requested shape. ok is false when the family
// cannot be put into that shape at all.
type Setup func(t *testing.T, shape Shape) (h Harness, ok bool)

const (
	// fourGiB is where a 32-bit octet counter wraps (ADR-0074).
	fourGiB = int64(1) << 32
	// petabyte is a figure no line could have served in a test's lifetime.
	petabyte = int64(1) << 50
)

func pull(semantics driver.CounterSemantics) Shape {
	return Shape{Transport: driver.TransportPull, CounterSemantics: semantics, CeilingSupported: true, GigawordsReported: false}
}

func push(gigawords bool) Shape {
	return Shape{Transport: driver.TransportPush, CounterSemantics: driver.CounterSession, CeilingSupported: true, GigawordsReported: gigawords}
}

// Run executes every scenario against one driver family. It is the whole
// acceptance of a driver: F-027-ae, F-027-ag, F-027-ah and F-027-ai each add
// an implementation and a call to this function, and nothing else.
func Run(t *testing.T, setup Setup) {
	t.Helper()
	cases := []struct {
		name  Scenario
		shape Shape
		run   func(t *testing.T, h Harness, shape Shape)
	}{
		{ScenarioCounterReset, pull(driver.CounterCumulative), counterReset},
		{ScenarioBackupRestore, pull(driver.CounterCumulative), backupRestoreCumulative},
		{ScenarioBackupRestore + "_session", push(true), backupRestoreSession},
		{ScenarioTimeout, pull(driver.CounterCumulative), timeout},
		{ScenarioSlowReply, pull(driver.CounterCumulative), slowReply},
		{ScenarioImplausibleFigure, pull(driver.CounterCumulative), implausibleFigure},
		{ScenarioSessionWithoutStop, push(true), sessionWithoutStop},
		{ScenarioMissingGigawords, push(false), missingGigawords},
		{ScenarioCounterWrap, push(true), counterWrap},
		{ScenarioCeilingRefused, Shape{driver.TransportPull, driver.CounterCumulative, false, false}, ceilingRefused},
		{ScenarioCeilingAppliedLate, pull(driver.CounterCumulative), ceilingAppliedLate},
		{ScenarioRateLimitedVsFault, pull(driver.CounterCumulative), rateLimitedVsServerFault},
	}
	for _, tc := range cases {
		t.Run(string(tc.name), func(t *testing.T) {
			h, ok := setup(t, tc.shape)
			if !ok {
				t.Skipf("this family cannot be put in the shape %s needs (%s/%s, ceiling=%v, gigawords=%v)",
					tc.name, tc.shape.Transport, tc.shape.CounterSemantics,
					tc.shape.CeilingSupported, tc.shape.GigawordsReported)
			}
			tc.run(t, h, tc.shape)
		})
	}
}

// usageOf reads the whole panel and returns one client's reading. Every
// scenario reads through GetUsage: one call for every client is the contract
// (catalog 8.4), so no scenario is allowed to demonstrate anything with a
// per-client read.
func usageOf(t *testing.T, h Harness, remoteID string) (driver.ClientUsage, bool) {
	t.Helper()
	readings, err := h.Driver().GetUsage(context.Background())
	if err != nil {
		t.Fatalf("GetUsage: %v", err)
	}
	for _, r := range readings {
		if r.RemoteID == remoteID {
			return r, true
		}
	}
	return driver.ClientUsage{}, false
}

func mustUsageOf(t *testing.T, h Harness, remoteID string) driver.ClientUsage {
	t.Helper()
	reading, ok := usageOf(t, h, remoteID)
	if !ok {
		t.Fatalf("GetUsage returned no reading for %s", remoteID)
	}
	return reading
}

// counterReset: a counter that goes backward is reported as it was read. The
// driver does not carry the old figure forward and never reports a negative
// one — "a counter going backward is a reset, never negative usage" is decided
// downstream, on evidence this driver is obliged to pass through (ADR-0074).
func counterReset(t *testing.T, h Harness, _ Shape) {
	h.Given("c1")
	h.Serve("c1", 1_000, 2_000)
	before := mustUsageOf(t, h, "c1")
	if before.UpBytes != 1_000 || before.DownBytes != 2_000 {
		t.Fatalf("first reading = %d/%d, want 1000/2000", before.UpBytes, before.DownBytes)
	}

	h.ZeroCounter("c1")
	h.Serve("c1", 10, 20)
	after := mustUsageOf(t, h, "c1")

	if after.UpBytes < 0 || after.DownBytes < 0 {
		t.Errorf("reading after a reset = %d/%d: a raw counter is never negative", after.UpBytes, after.DownBytes)
	}
	if after.UpBytes >= before.UpBytes || after.DownBytes >= before.DownBytes {
		t.Errorf("reading after a reset = %d/%d, not below %d/%d: the driver carried the old figure forward, "+
			"and the reset the normaliser decides on is no longer visible",
			after.UpBytes, after.DownBytes, before.UpBytes, before.DownBytes)
	}
}

// backupRestoreCumulative: a cumulative panel restored from backup reads as a
// reset — every counter back at the snapshot. The driver reports that, and the
// re-billing is prevented downstream by the same rule that handles a reset.
func backupRestoreCumulative(t *testing.T, h Harness, _ Shape) {
	h.Given("c1")
	h.Serve("c1", 5*fourGiB, 5*fourGiB)
	h.TakeBackup()
	atBackup := mustUsageOf(t, h, "c1")

	h.Serve("c1", 3*fourGiB, 3*fourGiB)
	grown := mustUsageOf(t, h, "c1")
	if grown.DownBytes <= atBackup.DownBytes {
		t.Fatalf("counter did not rise between backup and restore: %d then %d", atBackup.DownBytes, grown.DownBytes)
	}

	h.RestoreBackup()
	restored := mustUsageOf(t, h, "c1")
	if restored.DownBytes != atBackup.DownBytes || restored.UpBytes != atBackup.UpBytes {
		t.Errorf("after a restore the reading is %d/%d, want the snapshot's %d/%d",
			restored.UpBytes, restored.DownBytes, atBackup.UpBytes, atBackup.DownBytes)
	}
}

// backupRestoreSession: the property that makes session counters worth
// declaring. A restored session carries an id we have already seen, so the
// restore is deduplicated rather than re-counted — it does not read as
// thousands of simultaneous resets (ADR-0074).
func backupRestoreSession(t *testing.T, h Harness, _ Shape) {
	h.Given("c1")
	h.Serve("c1", 1_000, 2_000)
	first := mustUsageOf(t, h, "c1")
	if first.SessionID == "" {
		t.Fatal("a session-counter panel reported a reading with no SessionID: " +
			"without it a restored session cannot be told from a new one")
	}
	h.TakeBackup()

	h.ZeroCounter("c1") // the session ends and a new one starts
	h.Serve("c1", 5, 5)
	second := mustUsageOf(t, h, "c1")
	if second.SessionID == first.SessionID {
		t.Fatalf("a new session reused the id %q: session ids must not repeat", second.SessionID)
	}

	h.RestoreBackup()
	restored := mustUsageOf(t, h, "c1")
	if restored.SessionID != first.SessionID {
		t.Errorf("restored session id = %q, want the already-seen %q: a restore that mints new ids "+
			"is re-counted in full", restored.SessionID, first.SessionID)
	}
}

// timeout: a call that outlives its deadline fails as a timeout and returns at
// the deadline, not when the far end finally replies. The loop's budget is per
// panel, and a driver that blocks past its deadline spends another panel's turn.
func timeout(t *testing.T, h Harness, _ Shape) {
	h.Given("c1")
	h.StallNextCall(3 * time.Second)

	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	started := time.Now()
	_, err := h.Driver().GetUsage(ctx)
	elapsed := time.Since(started)

	if err == nil {
		t.Fatal("GetUsage past its deadline returned no error")
	}
	if !driver.IsTimeout(err) {
		t.Errorf("error is %v, want a driver.FaultTimeout: a deadline is not a panel fault and must not "+
			"quarantine the panel (F-027-l)", err)
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("error %v does not unwrap to context.DeadlineExceeded", err)
	}
	if elapsed > time.Second {
		t.Errorf("GetUsage returned after %s: it waited for the far end instead of its own deadline", elapsed)
	}
}

// slowReply: slow is not failed. A driver that gives up on a reply still
// inside its deadline turns a busy panel into a down one.
func slowReply(t *testing.T, h Harness, _ Shape) {
	h.Given("c1")
	h.Serve("c1", 7, 9)
	h.StallNextCall(50 * time.Millisecond)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	readings, err := h.Driver().GetUsage(ctx)
	if err != nil {
		t.Fatalf("a slow reply inside the deadline failed: %v", err)
	}
	var found bool
	for _, r := range readings {
		if r.RemoteID == "c1" {
			found = true
			if r.UpBytes != 7 || r.DownBytes != 9 {
				t.Errorf("slow reading = %d/%d, want 7/9", r.UpBytes, r.DownBytes)
			}
		}
	}
	if !found {
		t.Error("a slow reply came back without the client's reading")
	}
}

// implausibleFigure: the driver passes it through untouched. The plausibility
// cap is elapsed time times line rate and it belongs to the normaliser
// (F-027-l); a driver that clamped here would quietly bill the clamp.
func implausibleFigure(t *testing.T, h Harness, _ Shape) {
	h.Given("c1")
	h.Serve("c1", 0, petabyte)

	reading := mustUsageOf(t, h, "c1")
	if reading.DownBytes != petabyte {
		t.Errorf("implausible reading came back as %d, want the raw %d: a driver that clamps hides the "+
			"figure the quarantine decides on", reading.DownBytes, petabyte)
	}
	if reading.ObservedAt.IsZero() {
		t.Error("reading has no ObservedAt: the plausibility cap is bounded by our clock, so a reading " +
			"without one cannot be checked at all")
	}
}

// sessionWithoutStop: a session the NAS stopped updating keeps its last
// observed figure for as long as it is reported, and never grows. ADR-0074
// forbids extrapolating past it, and invariant 27 refuses to publish more than
// was measured.
func sessionWithoutStop(t *testing.T, h Harness, _ Shape) {
	h.Given("c1")
	h.Serve("c1", 1_000, 4_000)
	last := mustUsageOf(t, h, "c1")

	h.AbandonSession("c1")
	h.Serve("c1", 9_999, 9_999) // traffic the abandoned session never reports

	for pass := 0; pass < 3; pass++ {
		reading, ok := usageOf(t, h, "c1")
		if !ok {
			return // closed out at the far end: nothing was invented, which is the point
		}
		if reading.SessionID != last.SessionID {
			t.Fatalf("pass %d: session id changed to %q without a Stop", pass, reading.SessionID)
		}
		if reading.UpBytes != last.UpBytes || reading.DownBytes != last.DownBytes {
			t.Fatalf("pass %d: an abandoned session reported %d/%d, want its last observed %d/%d — "+
				"a figure past the last observation is the extrapolation ADR-0074 forbids",
				pass, reading.UpBytes, reading.DownBytes, last.UpBytes, last.DownBytes)
		}
	}
}

// missingGigawords: a NAS that omits Gigawords loses the high bits, and the
// loss is in the reading. The driver reports the truncated figure and answers
// the questionnaire row no — which is what lets the pipeline hold the session
// past 4 GB instead of billing a number that is 4 GB short (invariant 29).
func missingGigawords(t *testing.T, h Harness, shape Shape) {
	caps, err := h.Driver().Capabilities(context.Background())
	if err != nil {
		t.Fatalf("Capabilities: %v", err)
	}
	if caps.Supports(driver.RowGigawordsReported) {
		t.Fatal("the harness built a panel without Gigawords, but the driver answers the row yes: " +
			"a wrong answer here is 4 GB lost per wrap, in silence")
	}

	h.Given("c1")
	served := fourGiB + 5_000
	h.Serve("c1", 0, served)

	reading := mustUsageOf(t, h, "c1")
	if reading.DownBytes >= fourGiB {
		t.Errorf("reading = %d: a 32-bit counter with no Gigawords cannot report at or above %d",
			reading.DownBytes, fourGiB)
	}
	if reading.DownBytes != served-fourGiB {
		t.Errorf("reading = %d, want the low 32 bits %d: the driver must report what the NAS sent, "+
			"not a figure it reassembled from bits it never received", reading.DownBytes, served-fourGiB)
	}
}

// counterWrap: with Gigawords present the same traffic crosses 4 GB and keeps
// rising. The high bits are reassembled by the driver, once, so nothing
// downstream ever sees a 32-bit number.
func counterWrap(t *testing.T, h Harness, _ Shape) {
	caps, err := h.Driver().Capabilities(context.Background())
	if err != nil {
		t.Fatalf("Capabilities: %v", err)
	}
	if !caps.Supports(driver.RowGigawordsReported) {
		t.Fatal("the harness built a panel with Gigawords, but the driver answers the row no")
	}

	h.Given("c1")
	served := fourGiB + 5_000
	h.Serve("c1", 0, served)
	if got := mustUsageOf(t, h, "c1").DownBytes; got != served {
		t.Fatalf("reading = %d, want %d: the counter wrapped and the high bits were not reassembled", got, served)
	}

	h.Serve("c1", 0, 3*fourGiB)
	if got := mustUsageOf(t, h, "c1").DownBytes; got != served+3*fourGiB {
		t.Errorf("after a second wrap the reading = %d, want %d", got, served+3*fourGiB)
	}
}

// ceilingRefused: a panel that cannot enforce a per-client ceiling says so in
// the questionnaire and fails the write. It is accepted — it may still carry
// prepaid service — but metered sale is withheld, because the ceiling is the
// only enforcement point that survives this service being down (ADR-0072,
// invariant 32).
func ceilingRefused(t *testing.T, h Harness, shape Shape) {
	d := h.Driver()
	caps, err := d.Capabilities(context.Background())
	if err != nil {
		t.Fatalf("Capabilities: %v", err)
	}
	if caps.Supports(driver.RowPerClientDataLimit) {
		t.Fatal("the harness built a panel with no ceiling, but the driver answers the row yes")
	}

	h.Given("c1")
	err = d.SetClientDataLimit(context.Background(), "c1", 42*fourGiB)
	if err == nil {
		t.Fatal("SetClientDataLimit succeeded on a panel that cannot enforce one: a ceiling believed " +
			"and not enforced is worse than no ceiling — every byte past it is served unpaid")
	}
	if !driver.IsUnsupported(err) {
		t.Errorf("error is %v, want a driver.FaultUnsupported: the panel is healthy and retrying will "+
			"not help, so this must not read as a panel fault", err)
	}

	verdict := caps.Verdict(shape.Transport, shape.CounterSemantics)
	if verdict.MeteredSaleAllowed {
		t.Error("metered sale allowed on a panel with no enforceable ceiling (invariant 32, ADR-0072)")
	}
	if verdict.ReviewState == driver.ReviewRefused {
		t.Error("the panel was refused outright: a missing ceiling is `metered` severity, and prepaid " +
			"service on it is the owner's call (F-027-aj)")
	}
}

// ceilingAppliedLate: the write is accepted and the far end reflects it some
// reads later. Every read reports the ceiling the panel is actually
// enforcing — never the one we asked for — so the convergence loop sees
// applied != allocated and rewrites it (F-027-t).
func ceilingAppliedLate(t *testing.T, h Harness, _ Shape) {
	d := h.Driver()
	h.Given("c1")
	h.DelayCeilingBy(2)

	const ceiling = 42 * fourGiB
	if err := d.SetClientDataLimit(context.Background(), "c1", ceiling); err != nil {
		t.Fatalf("SetClientDataLimit: %v", err)
	}

	for pass := 1; pass <= 2; pass++ {
		if got := limitOf(t, d, "c1"); got == ceiling {
			t.Fatalf("pass %d reported the ceiling as applied before the far end took it: the driver "+
				"echoed the write instead of reading the panel, and convergence would stop here", pass)
		}
	}
	if got := limitOf(t, d, "c1"); got != ceiling {
		t.Errorf("after the far end took the write the ceiling reads %d, want %d", got, ceiling)
	}
}

func limitOf(t *testing.T, d driver.Driver, remoteID string) int64 {
	t.Helper()
	clients, err := d.ListClients(context.Background())
	if err != nil {
		t.Fatalf("ListClients: %v", err)
	}
	for _, c := range clients {
		if c.RemoteID == remoteID {
			return c.DataLimitBytes
		}
	}
	t.Fatalf("ListClients returned no client %s", remoteID)
	return 0
}

// rateLimitedVsServerFault: 429 is not 5xx. Asking too often leaves a healthy
// panel that wants a slower caller; a 5xx is the panel failing. Conflating
// them either quarantines a panel we were rude to, or keeps hammering one that
// is down — and F-027-v's budget is written on this distinction.
func rateLimitedVsServerFault(t *testing.T, h Harness, _ Shape) {
	d := h.Driver()
	h.Given("c1")

	h.FailNextCall(429)
	err := callAndFail(t, d, "429")
	if !driver.IsRateLimited(err) {
		t.Errorf("429 gave %v, want driver.FaultRateLimited", err)
	}
	if driver.IsUnavailable(err) {
		t.Error("429 read as unavailable: the panel is healthy and asking it less is the whole remedy")
	}
	if !driver.IsThrottledOrBlocked(err) {
		t.Error("429 is not throttled_or_blocked, which is the bucket the request budget reads (F-027-v)")
	}

	h.FailNextCall(503)
	err = callAndFail(t, d, "503")
	if !driver.IsUnavailable(err) {
		t.Errorf("503 gave %v, want driver.FaultUnavailable", err)
	}
	if driver.IsRateLimited(err) || driver.IsThrottledOrBlocked(err) {
		t.Error("503 read as throttled: backing off politely does not fix a panel that is down")
	}

	h.FailNextCall(403)
	err = callAndFail(t, d, "403")
	if driver.IsUnavailable(err) {
		t.Errorf("403 gave %v, want a blocked fault and not a panel fault: retrying a block is the "+
			"behaviour that gets our address banned (F-027-v)", err)
	}
	if !driver.IsThrottledOrBlocked(err) {
		t.Errorf("403 gave %v, want it in the throttled_or_blocked bucket beside 429", err)
	}

	// A fault is one call's, not the panel's state: the next pass must work.
	if _, err := d.GetUsage(context.Background()); err != nil {
		t.Errorf("the call after a scripted failure also failed: %v", err)
	}
}

func callAndFail(t *testing.T, d driver.Driver, label string) error {
	t.Helper()
	_, err := d.GetUsage(context.Background())
	if err == nil {
		t.Fatalf("%s: GetUsage returned no error", label)
	}
	var fault *driver.Fault
	if !errors.As(err, &fault) {
		t.Fatalf("%s: error %v is not a *driver.Fault, so nothing downstream can tell why the call failed", label, err)
	}
	return err
}
