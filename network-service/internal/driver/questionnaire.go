package driver

import (
	"fmt"
	"sort"
	"time"
)

// The acceptance questionnaire (ADR-0074).
//
// Sixteen rows, fixed and closed. A panel answers every row that applies to
// its transport, by connection test at registration and never by hand, and
// the answers are stored as `network.panel.capabilities` — a JSONB document
// the database holds no shape for, so this file is the shape.
//
// Every row changes behaviour. A capability that changes nothing is a comment,
// and this questionnaire is not documentation: `Verdict` refuses a panel that
// fails a load-bearing row, withholds metered sale from one that cannot
// enforce a ceiling, and the rest hold bytes rather than guessing at them.

// CapabilitiesVersion is the document version. `capabilities` is validated and
// versioned on write, because the column cannot validate itself; a document
// written under an older version is re-answered by a connection test rather
// than migrated, since the answers are observations and not settings.
const CapabilitiesVersion = 1

// RowKey names one row. These strings cross a process boundary — written here,
// read by the panel's capability matrix in TypeScript (F-027-ad) — so their
// declared home is `contracts/network/capabilities.json`, with a test on each
// side (ADR-0036, C-04).
type RowKey string

const (
	RowPerClientUsage          RowKey = "per_client_usage"
	RowBulkUsageInOneCall      RowKey = "bulk_usage_in_one_call"
	RowUsageForNamedSubset     RowKey = "usage_for_named_subset"
	RowUsageResetSupported     RowKey = "usage_reset_supported"
	RowCounterSurvivesUpdate   RowKey = "counter_survives_client_update"
	RowGigawordsReported       RowKey = "gigawords_reported"
	RowPerClientDataLimit      RowKey = "per_client_data_limit"
	RowDataLimitCountsSameByte RowKey = "data_limit_counts_the_same_bytes_as_usage"
	RowPerClientRateLimit      RowKey = "per_client_rate_limit"
	RowEnableDisableClient     RowKey = "enable_disable_client"
	RowClientLifecycle         RowKey = "client_lifecycle"
	RowStableRemoteID          RowKey = "stable_remote_id"
	RowClientLabelStorable     RowKey = "client_label_storable"
	RowNativeSubscriptionLink  RowKey = "native_subscription_link"
	RowServerSideExpiry        RowKey = "server_side_expiry"
	RowInternalCreditDisabled  RowKey = "internal_credit_disablable"
)

// Scope is which transports a row applies to. A pull panel is never asked
// about Gigawords and a push source is never asked for a bulk endpoint we do
// not call: an answer outside a row's scope is a declaration about something
// that does not happen, which is worse than no answer.
type Scope string

const (
	ScopeAny  Scope = "any"
	ScopePull Scope = "pull"
	ScopePush Scope = "push"
)

// Includes says whether a panel on this transport answers rows of this scope.
func (s Scope) Includes(t Transport) bool {
	return s == ScopeAny || string(s) == string(t)
}

// Severity is what an unmet row costs. Three levels, because the three
// outcomes ADR-0074 describes are genuinely different: refusal, a narrower
// product, and a behaviour change we absorb.
type Severity string

const (
	// SeverityRequired: the panel is refused at registration. It cannot carry
	// users at all.
	SeverityRequired Severity = "required"
	// SeverityMetered: the panel is accepted, but may not sell metered
	// service. Prepaid only, or refused outright, per the owner's answer.
	SeverityMetered Severity = "metered"
	// SeverityDegrades: the panel is accepted and the system does something
	// else — holds bytes, re-reads a cursor, falls back to another matching
	// key. Never a guess.
	SeverityDegrades Severity = "degrades"
)

// Row is one question of the questionnaire, and what happens when the answer
// is no. Unmet is not commentary: it is the behaviour the rest of the network
// plane is written to.
type Row struct {
	Key      RowKey
	Scope    Scope
	Severity Severity
	Question string
	Unmet    string
}

var questionnaire = []Row{
	{
		Key: RowPerClientUsage, Scope: ScopeAny, Severity: SeverityRequired,
		Question: "Does it report a usage figure for one named client, rather than only a server total?",
		Unmet:    "Refused: a server total cannot be split between the users on it, so there is nothing to bill (ADR-0074, revisit trigger).",
	},
	{
		Key: RowBulkUsageInOneCall, Scope: ScopePull, Severity: SeverityRequired,
		Question: "Does one call return the usage of every client on the panel?",
		Unmet:    "Refused: 5000 clients would be 5000 requests a pass on someone else's server (catalog 8.4, F-027-k).",
	},
	{
		Key: RowUsageForNamedSubset, Scope: ScopePull, Severity: SeverityDegrades,
		Question: "Does one call return the usage of a named subset of clients?",
		Unmet:    "The hot loop re-reads the whole panel each pass, so its interval is bounded by the cost of the bulk call (F-027-u).",
	},
	{
		Key: RowUsageResetSupported, Scope: ScopeAny, Severity: SeverityDegrades,
		Question: "Can a client's counter be zeroed on request?",
		Unmet:    "Nothing is lost: we only ever read a counter. A reset is something we detect, never something we cause (F-027-l).",
	},
	{
		Key: RowCounterSurvivesUpdate, Scope: ScopeAny, Severity: SeverityDegrades,
		Question: "Does a client's counter keep its value when the client is updated — a ceiling written, a label changed?",
		Unmet:    "Every ceiling write looks like a reset, so the cursor is re-read in the same pass as the write instead of at the next one (ADR-0072, F-027-t).",
	},
	{
		Key: RowGigawordsReported, Scope: ScopePush, Severity: SeverityDegrades,
		Question: "Does the NAS send Acct-Input-Gigawords and Acct-Output-Gigawords beside the 32-bit octet counters?",
		Unmet:    "A session past 4 GB is held rather than billed, and never extrapolated (invariant 29, ADR-0074).",
	},
	{
		Key: RowPerClientDataLimit, Scope: ScopeAny, Severity: SeverityMetered,
		Question: "Can a byte ceiling be written for one client, and does the panel enforce it itself?",
		Unmet:    "No metered sale: the ceiling is the only enforcement point that still works while our service is down, and without it no byte can be paid for before it is served (ADR-0072).",
	},
	{
		Key: RowDataLimitCountsSameByte, Scope: ScopeAny, Severity: SeverityMetered,
		Question: "Does the enforced ceiling count the same bytes the usage figure reports — both directions, same units?",
		Unmet:    "No metered sale: a block bought against the cursor would be spent against a different number, and the gap is free traffic with nothing red anywhere.",
	},
	{
		Key: RowPerClientRateLimit, Scope: ScopeAny, Severity: SeverityDegrades,
		Question: "Can a bandwidth rate be written for one client?",
		Unmet:    "A custom rate rule is recorded and not enforced at the far end; layer-1 limiting stays ours.",
	},
	{
		Key: RowEnableDisableClient, Scope: ScopeAny, Severity: SeverityRequired,
		Question: "Can one client be disabled and re-enabled without deleting it?",
		Unmet:    "Refused: suspension would have to delete the client, and a top-up could then not restore it (ADR-0075, F-027-x).",
	},
	{
		Key: RowClientLifecycle, Scope: ScopeAny, Severity: SeverityRequired,
		Question: "Can a client be created, updated and deleted through the API?",
		Unmet:    "Refused: nothing can be provisioned or purged, so desired state has nothing to converge on (F-027-z).",
	},
	{
		Key: RowStableRemoteID, Scope: ScopeAny, Severity: SeverityDegrades,
		Question: "Does a client carry an id that survives being renamed?",
		Unmet:    "Matching falls through to the claim tag and then the uuid, so a rename reads as missing until the second key is tried (F-027-aa).",
	},
	{
		Key: RowClientLabelStorable, Scope: ScopeAny, Severity: SeverityDegrades,
		Question: "Can we store our own claim tag on the client — a note, label or remark field we own?",
		Unmet:    "The second matching key does not exist here, so a client rebuilt on the far end reads as an orphan rather than as ours (F-027-aa).",
	},
	{
		Key: RowNativeSubscriptionLink, Scope: ScopeAny, Severity: SeverityDegrades,
		Question: "Does the panel serve a subscription URL for a client?",
		Unmet:    "The link is built from the inbound by BuildLink, so an inbound change reaches the user only when the link is fetched again.",
	},
	{
		Key: RowServerSideExpiry, Scope: ScopeAny, Severity: SeverityDegrades,
		Question: "Does the panel enforce an expiry date on a client by itself?",
		Unmet:    "Expiry is ours alone: a Grant that ends while our loop is down leaves the client carrying traffic until the loop returns.",
	},
	{
		Key: RowInternalCreditDisabled, Scope: ScopeAny, Severity: SeverityDegrades,
		Question: "Can the panel's own billing or credit be switched off, leaving us the only writer of the quota?",
		Unmet:    "The panel cuts users off on a schedule we do not control, so it is run metering_only and the tenant keeps its own billing (F-027-ag).",
	},
}

// Questionnaire is the fixed 16 rows, in their declared order. The order is
// part of the contract: the fixture and the panel's capability matrix read it.
func Questionnaire() []Row {
	rows := make([]Row, len(questionnaire))
	copy(rows, questionnaire)
	return rows
}

// RowByKey looks one row up. The second result is false for a key that is not
// part of the questionnaire — which is not a lookup miss but a capability
// somebody invented.
func RowByKey(key RowKey) (Row, bool) {
	for _, row := range questionnaire {
		if row.Key == key {
			return row, true
		}
	}
	return Row{}, false
}

// Answer is one row's answer, as the connection test observed it. Detail is
// how it was established, or why the answer is no — it reaches the panel's
// capability matrix, so it is written for the person deciding whether to buy
// this server.
type Answer struct {
	Supported bool   `json:"supported"`
	Detail    string `json:"detail,omitempty"`
}

// Capabilities is the document stored in `network.panel.capabilities`.
type Capabilities struct {
	Version    int               `json:"version"`
	AnsweredAt time.Time         `json:"answeredAt,omitempty"`
	Answers    map[RowKey]Answer `json:"answers"`
}

// Supports reports one row's answer. An unanswered row is not supported: the
// questionnaire is closed, so silence is a no and never an assumption.
func (c Capabilities) Supports(key RowKey) bool {
	return c.Answers[key].Supported
}

// Validate holds the document to the questionnaire: the version we can read,
// every in-scope row answered, and nothing else answered at all.
//
// It runs on write. The column is JSONB and the database holds no shape, so
// this is the only place the shape exists (ADR-0074).
func (c Capabilities) Validate(transport Transport) error {
	if c.Version != CapabilitiesVersion {
		return fmt.Errorf("capabilities version %d is not readable (this service writes and reads %d)",
			c.Version, CapabilitiesVersion)
	}

	var missing, unknown, outOfScope []string
	for _, row := range questionnaire {
		_, answered := c.Answers[row.Key]
		switch {
		case row.Scope.Includes(transport) && !answered:
			missing = append(missing, string(row.Key))
		case !row.Scope.Includes(transport) && answered:
			outOfScope = append(outOfScope, string(row.Key))
		}
	}
	for key := range c.Answers {
		if _, ok := RowByKey(key); !ok {
			unknown = append(unknown, string(key))
		}
	}
	sort.Strings(missing)
	sort.Strings(unknown)
	sort.Strings(outOfScope)

	switch {
	case len(missing) > 0:
		return fmt.Errorf("unanswered questionnaire rows for a %s panel: %v", transport, missing)
	case len(unknown) > 0:
		return fmt.Errorf("answers to rows that are not in the questionnaire: %v", unknown)
	case len(outOfScope) > 0:
		return fmt.Errorf("answers to rows a %s panel is never asked: %v", transport, outOfScope)
	}
	return nil
}

// Verdict is what registration does with the answers.
type Verdict struct {
	ReviewState ReviewState
	// MeteredSaleAllowed is ADR-0072's precondition: a panel that cannot
	// enforce a per-user ceiling cannot sell traffic that is paid for before
	// it is served. It may still carry prepaid service, which is the owner's
	// call and not this function's.
	MeteredSaleAllowed bool
	// Unmet is every in-scope row answered no, in questionnaire order.
	Unmet []RowKey
	// Reasons is one line per unmet row, for the refusal the panel's systems
	// page shows at registration rather than at billing time.
	Reasons []string
}

// Verdict decides a panel's ReviewState from its answers and its declared
// counter semantics. It reads no database and calls no panel: registration
// runs the connection test, then this.
func (c Capabilities) Verdict(transport Transport, semantics CounterSemantics) Verdict {
	verdict := Verdict{ReviewState: ReviewAccepted, MeteredSaleAllowed: true}

	for _, row := range questionnaire {
		if !row.Scope.Includes(transport) || c.Supports(row.Key) {
			continue
		}
		verdict.Unmet = append(verdict.Unmet, row.Key)
		verdict.Reasons = append(verdict.Reasons, string(row.Key)+": "+row.Unmet)
		switch row.Severity {
		case SeverityRequired:
			verdict.ReviewState = ReviewRefused
		case SeverityMetered:
			verdict.MeteredSaleAllowed = false
		}
	}

	if verdict.ReviewState == ReviewRefused {
		verdict.MeteredSaleAllowed = false
		return verdict
	}
	// A source restricted to reset_on_read loses the bytes of any read whose
	// publish fails, permanently. It is accepted with its loss window bounded
	// to one interval, and marked so nobody reads its figures as equal to the
	// rest (ADR-0074).
	if semantics == CounterResetOnRead {
		verdict.ReviewState = ReviewAcceptedLowTrust
	}
	return verdict
}
