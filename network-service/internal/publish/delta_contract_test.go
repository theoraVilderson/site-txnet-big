package publish

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// The Go half of the cross-language contract (ADR-0036, C-04/C-08).
//
// network-service is not in the Nx workspace and cannot import shared-core, so
// the routing key it publishes under and every field it writes are declared in
// `contracts/network/delta.json` and asserted here; the TypeScript half is
// `usage-delta.contract.spec.ts`. A field renamed on one side goes red on both
// rather than arriving at the consumer as an absent value — a delta silently
// worth zero bytes is a bill nobody can reconstruct afterwards.

const fixturePath = "../../../contracts/network/delta.json"

type declaredField struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

type fixtureFile struct {
	Version  int `json:"version"`
	Exchange struct {
		Default string `json:"default"`
	} `json:"exchange"`
	RoutingKeys struct {
		Prefix     string `json:"prefix"`
		UsageDelta string `json:"usageDelta"`
	} `json:"routingKeys"`
	MaxDeltasPerMessage int `json:"maxDeltasPerMessage"`
	DeltaIDNamespace    struct {
		UUID      string   `json:"uuid"`
		Fields    []string `json:"fields"`
		Separator string   `json:"separator"`
	} `json:"deltaIdNamespace"`
	Message struct {
		Envelope     []declaredField `json:"envelope"`
		Delta        []declaredField `json:"delta"`
		Quarantine   []declaredField `json:"quarantine"`
		Unattributed []declaredField `json:"unattributed"`
	} `json:"message"`
}

func loadFixture(t *testing.T) fixtureFile {
	t.Helper()
	raw, err := os.ReadFile(filepath.Clean(fixturePath))
	if err != nil {
		t.Fatalf("read fixture %s: %v", fixturePath, err)
	}
	var fixture fixtureFile
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	return fixture
}

func TestConstantsMatchTheDeclaredFixture(t *testing.T) {
	fixture := loadFixture(t)

	if MessageVersion != fixture.Version {
		t.Errorf("MessageVersion = %d, fixture = %d", MessageVersion, fixture.Version)
	}
	if UsageDeltaRoutingKey != fixture.RoutingKeys.UsageDelta {
		t.Errorf("UsageDeltaRoutingKey = %q, fixture = %q", UsageDeltaRoutingKey, fixture.RoutingKeys.UsageDelta)
	}
	if !strings.HasPrefix(UsageDeltaRoutingKey, fixture.RoutingKeys.Prefix) {
		t.Errorf("routing key %q is outside the declared prefix %q", UsageDeltaRoutingKey, fixture.RoutingKeys.Prefix)
	}
	if DefaultExchange != fixture.Exchange.Default {
		t.Errorf("DefaultExchange = %q, fixture = %q", DefaultExchange, fixture.Exchange.Default)
	}
	if MaxDeltasPerMessage != fixture.MaxDeltasPerMessage {
		t.Errorf("MaxDeltasPerMessage = %d, fixture = %d", MaxDeltasPerMessage, fixture.MaxDeltasPerMessage)
	}
	if deltaIDNamespace.String() != fixture.DeltaIDNamespace.UUID {
		t.Errorf("deltaIdNamespace = %s, fixture = %s", deltaIDNamespace, fixture.DeltaIDNamespace.UUID)
	}
	if fixture.DeltaIDNamespace.Separator != deltaIDSeparator {
		t.Errorf("deltaIdSeparator = %q, fixture = %q", deltaIDSeparator, fixture.DeltaIDNamespace.Separator)
	}
}

// Every declared field, in order, with the Go type the declared type requires.
// Order is asserted too: the fixture is read by a person deciding what the
// consumer sees, and a list that drifts out of order is one nobody can diff.
func TestMessageShapeMatchesTheDeclaredFixture(t *testing.T) {
	fixture := loadFixture(t)

	for _, tc := range []struct {
		name     string
		declared []declaredField
		goType   reflect.Type
	}{
		{"envelope", fixture.Message.Envelope, reflect.TypeOf(UsageDeltaMessage{})},
		{"delta", fixture.Message.Delta, reflect.TypeOf(Delta{})},
		{"quarantine", fixture.Message.Quarantine, reflect.TypeOf(Quarantine{})},
		{"unattributed", fixture.Message.Unattributed, reflect.TypeOf(Unattributed{})},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if tc.goType.NumField() != len(tc.declared) {
				t.Fatalf("%s has %d Go fields, fixture declares %d", tc.name, tc.goType.NumField(), len(tc.declared))
			}
			for i, want := range tc.declared {
				field := tc.goType.Field(i)
				got := strings.Split(field.Tag.Get("json"), ",")[0]
				if got != want.Name {
					t.Errorf("%s field %d: json tag %q, fixture %q", tc.name, i, got, want.Name)
					continue
				}
				if err := holdsType(field.Type, want.Type); err != nil {
					t.Errorf("%s.%s: %v", tc.name, want.Name, err)
				}
			}
		})
	}
}

// holdsType is the declared vocabulary, in Go terms. `bytes` is a string on
// purpose and the assertion is the point of the row: a BIGINT written as a
// JSON number loses precision past 2^53 in the consumer's JSON.parse, and the
// only visible symptom is a wrong bill.
func holdsType(got reflect.Type, declared string) error {
	want := reflect.TypeOf("")
	switch {
	case declared == "int":
		want = reflect.TypeOf(0)
	case declared == "bool":
		want = reflect.TypeOf(false)
	case strings.HasSuffix(declared, "[]"):
		if got.Kind() != reflect.Slice {
			return errType(got, "a slice")
		}
		return nil
	case strings.HasSuffix(declared, "?") && strings.HasPrefix(declared, "uuid"):
		// A nullable column is a pointer, so an absent value is JSON null
		// rather than an empty string the consumer has to re-interpret.
		if got.Kind() != reflect.Ptr || got.Elem() != want {
			return errType(got, "*string")
		}
		return nil
	}
	if got != want {
		return errType(got, want.String())
	}
	return nil
}

func errType(got reflect.Type, want string) error {
	return &typeError{got: got.String(), want: want}
}

type typeError struct{ got, want string }

func (e *typeError) Error() string { return "is " + e.got + ", the declared type needs " + e.want }
