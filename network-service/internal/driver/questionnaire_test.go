package driver

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The invariant this row turns on: a wrong or missing declaration is a silent
// wrong number, never a crash (ADR-0074). So the questionnaire is asserted as
// a fixed, closed set, and the verdict it produces is asserted as behaviour —
// a refusal at registration, or metered sale withheld — rather than as a
// document nobody reads.

const fixturePath = "../../../contracts/network/capabilities.json"

type fixtureFile struct {
	Version int `json:"version"`
	Rows    []struct {
		Key      string `json:"key"`
		Scope    string `json:"scope"`
		Severity string `json:"severity"`
		Question string `json:"question"`
		Unmet    string `json:"unmet"`
	} `json:"rows"`
}

// The Go half of the cross-language contract (ADR-0036): these keys are
// written into `network.panel.capabilities` here and read by the panel's
// capability matrix in TypeScript (F-027-ad), and no import joins the two.
func TestQuestionnaireMatchesTheDeclaredFixture(t *testing.T) {
	raw, err := os.ReadFile(filepath.Clean(fixturePath))
	if err != nil {
		t.Fatalf("read fixture %s: %v", fixturePath, err)
	}
	var fixture fixtureFile
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}

	if fixture.Version != CapabilitiesVersion {
		t.Errorf("fixture version = %d, want %d", fixture.Version, CapabilitiesVersion)
	}
	rows := Questionnaire()
	if len(rows) != 16 {
		t.Fatalf("questionnaire has %d rows, want the fixed 16", len(rows))
	}
	if len(fixture.Rows) != len(rows) {
		t.Fatalf("fixture has %d rows, questionnaire has %d", len(fixture.Rows), len(rows))
	}
	for i, row := range rows {
		got := fixture.Rows[i]
		if got.Key != string(row.Key) || got.Scope != string(row.Scope) ||
			got.Severity != string(row.Severity) {
			t.Errorf("row %d: fixture {%s %s %s}, questionnaire {%s %s %s}",
				i, got.Key, got.Scope, got.Severity, row.Key, row.Scope, row.Severity)
			continue
		}
		// The prose is part of the contract: the panel renders the refusal
		// from the fixture and this service renders it from the constant.
		if got.Question != row.Question || got.Unmet != row.Unmet {
			t.Errorf("row %q: fixture and questionnaire disagree on what the row asks or what an unmet answer costs", row.Key)
		}
	}
}

func TestEveryRowIsUniqueAndSaysWhatAnUnmetAnswerDoes(t *testing.T) {
	seen := map[RowKey]bool{}
	for _, row := range Questionnaire() {
		if seen[row.Key] {
			t.Errorf("duplicate row key %q", row.Key)
		}
		seen[row.Key] = true
		// ADR-0074: a capability that does not change behaviour is a comment.
		if row.Question == "" || row.Unmet == "" {
			t.Errorf("row %q has no question or no consequence", row.Key)
		}
	}
}

// A panel answers every row that applies to its transport, and no other.
func TestValidateRefusesAnIncompleteOrInventedAnswerSheet(t *testing.T) {
	full := answersFor(TransportPull, true)

	if err := (Capabilities{Version: CapabilitiesVersion, Answers: full}).Validate(TransportPull); err != nil {
		t.Fatalf("a complete sheet did not validate: %v", err)
	}

	missing := answersFor(TransportPull, true)
	delete(missing, RowPerClientUsage)
	if err := (Capabilities{Version: CapabilitiesVersion, Answers: missing}).Validate(TransportPull); err == nil {
		t.Error("an unanswered row validated")
	}

	invented := answersFor(TransportPull, true)
	invented["supports_telepathy"] = Answer{Supported: true}
	if err := (Capabilities{Version: CapabilitiesVersion, Answers: invented}).Validate(TransportPull); err == nil {
		t.Error("an unknown row validated — a capability outside the questionnaire does not exist")
	}

	outOfScope := answersFor(TransportPull, true)
	outOfScope[RowGigawordsReported] = Answer{Supported: true}
	if err := (Capabilities{Version: CapabilitiesVersion, Answers: outOfScope}).Validate(TransportPull); err == nil {
		t.Error("a push-only row validated on a pull panel")
	}

	if err := (Capabilities{Version: CapabilitiesVersion + 1, Answers: full}).Validate(TransportPull); err == nil {
		t.Error("an unsupported document version validated")
	}
}

func TestAPanelFailingALoadBearingRowIsRefusedAtRegistration(t *testing.T) {
	answers := answersFor(TransportPull, true)
	answers[RowPerClientUsage] = Answer{Supported: false}
	caps := Capabilities{Version: CapabilitiesVersion, Answers: answers}

	verdict := caps.Verdict(TransportPull, CounterCumulative)

	if verdict.ReviewState != ReviewRefused {
		t.Errorf("reviewState = %q, want %q", verdict.ReviewState, ReviewRefused)
	}
	if verdict.MeteredSaleAllowed {
		t.Error("a refused panel may not sell metered service")
	}
	if len(verdict.Unmet) != 1 || verdict.Unmet[0] != RowPerClientUsage {
		t.Errorf("unmet = %v, want just %q", verdict.Unmet, RowPerClientUsage)
	}
}

// The row's own note: `SetClientDataLimit` is what makes ADR-0072 possible, and
// a panel without it cannot sell metered service. It is not refused for it —
// F-027-aj's answer was prepaid or refused, per panel, not automatic.
func TestAPanelWithNoDataLimitIsAcceptedButSellsNoMeteredService(t *testing.T) {
	answers := answersFor(TransportPull, true)
	answers[RowPerClientDataLimit] = Answer{Supported: false, Detail: "no per-peer quota"}
	caps := Capabilities{Version: CapabilitiesVersion, Answers: answers}

	verdict := caps.Verdict(TransportPull, CounterCumulative)

	if verdict.ReviewState != ReviewAccepted {
		t.Errorf("reviewState = %q, want %q", verdict.ReviewState, ReviewAccepted)
	}
	if verdict.MeteredSaleAllowed {
		t.Error("metered sale was allowed on a panel that cannot enforce a ceiling")
	}
}

// ADR-0074: if the publish after the read fails, those bytes are gone
// permanently, so a source restricted to `reset_on_read` is marked low-trust.
func TestResetOnReadIsAcceptedOnlyAsLowTrust(t *testing.T) {
	caps := Capabilities{Version: CapabilitiesVersion, Answers: answersFor(TransportPull, true)}

	verdict := caps.Verdict(TransportPull, CounterResetOnRead)

	if verdict.ReviewState != ReviewAcceptedLowTrust {
		t.Errorf("reviewState = %q, want %q", verdict.ReviewState, ReviewAcceptedLowTrust)
	}
	if !verdict.MeteredSaleAllowed {
		t.Error("low trust bounds the loss window; it does not stop metered sale")
	}
}

// The scopes are not cosmetic: the bulk call is what makes a pull panel
// affordable, and Gigawords is what makes a push source billable past 4 GB.
func TestScopeDecidesWhichRowsAPanelAnswers(t *testing.T) {
	pushOnly := answersFor(TransportPush, true)
	if _, ok := pushOnly[RowBulkUsageInOneCall]; ok {
		t.Error("a push source was asked for a bulk usage endpoint it never calls")
	}
	if _, ok := pushOnly[RowGigawordsReported]; !ok {
		t.Error("a push source was not asked about Gigawords")
	}

	answers := answersFor(TransportPull, true)
	answers[RowBulkUsageInOneCall] = Answer{Supported: false}
	if state := (Capabilities{Version: CapabilitiesVersion, Answers: answers}).
		Verdict(TransportPull, CounterCumulative).ReviewState; state != ReviewRefused {
		t.Errorf("a pull panel with no bulk endpoint: reviewState = %q, want %q", state, ReviewRefused)
	}
}

// answersFor is the sheet a connection test would hand back — every in-scope
// row answered the same way. It is not a fake driver: that is F-027-j.
func answersFor(transport Transport, supported bool) map[RowKey]Answer {
	answers := map[RowKey]Answer{}
	for _, row := range Questionnaire() {
		if row.Scope.Includes(transport) {
			answers[row.Key] = Answer{Supported: supported}
		}
	}
	return answers
}
