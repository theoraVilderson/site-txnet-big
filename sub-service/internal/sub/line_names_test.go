package sub

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
)

// The Go half of how a served line is named (F-307-h, ADR-0089). Billing's
// config list names the same stored lines in TypeScript, and a copied line
// must carry the name an imported `/sub` shows. `contracts/network/
// line-names.json` is the declared home of the rule; the TypeScript half is
// billing-service/src/app/traffic/line-names.spec.ts.
const lineNamesFixture = "../../../contracts/network/line-names.json"

type lineNamesContract struct {
	PlatformTemplate string `json:"platformTemplate"`
	MaxLabelLength   int    `json:"maxLabelLength"`
	TemplateCases    []struct {
		Why      string  `json:"why"`
		Template *string `json:"template"`
		Brand    string  `json:"brand"`
		Region   string  `json:"region"`
		Expect   string  `json:"expect"`
	} `json:"templateCases"`
	LineCases []struct {
		Why         string         `json:"why"`
		Line        string         `json:"line"`
		Name        string         `json:"name"`
		Expect      *string        `json:"expect"`
		ExpectVmess map[string]any `json:"expectVmess"`
	} `json:"lineCases"`
	GrantCases []struct {
		Why      string  `json:"why"`
		Template *string `json:"template"`
		Brand    string  `json:"brand"`
		Configs  []struct {
			Region string  `json:"region"`
			Label  *string `json:"label"`
			Lines  int     `json:"lines"`
		} `json:"configs"`
		ExpectNames [][]*string `json:"expectNames"`
	} `json:"grantCases"`
}

func readLineNames(t *testing.T) lineNamesContract {
	t.Helper()
	raw, err := os.ReadFile(lineNamesFixture)
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var c lineNamesContract
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	return c
}

func TestLineNamesTemplateMatchesContract(t *testing.T) {
	c := readLineNames(t)
	if platformLineNameTemplate != c.PlatformTemplate {
		t.Fatalf("template %q, contract says %q", platformLineNameTemplate, c.PlatformTemplate)
	}
}

func TestLineNameTemplateMatchesContract(t *testing.T) {
	for _, tc := range readLineNames(t).TemplateCases {
		t.Run(tc.Why, func(t *testing.T) {
			n := LineNaming{Brand: tc.Brand}
			if tc.Template != nil {
				n.Template = *tc.Template
			}
			if got := n.base(tc.Region); got != tc.Expect {
				t.Fatalf("got %q, want %q", got, tc.Expect)
			}
		})
	}
}

func TestNameLineMatchesContract(t *testing.T) {
	for _, tc := range readLineNames(t).LineCases {
		t.Run(tc.Why, func(t *testing.T) {
			got := nameLine(tc.Line, tc.Name)
			if tc.ExpectVmess != nil {
				raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(got, "vmess://"))
				if err != nil {
					t.Fatalf("not base64: %q", got)
				}
				var obj map[string]any
				if err := json.Unmarshal(raw, &obj); err != nil {
					t.Fatalf("not JSON: %s", raw)
				}
				if !reflect.DeepEqual(obj, tc.ExpectVmess) {
					t.Fatalf("got %v, want %v", obj, tc.ExpectVmess)
				}
				return
			}
			if got != *tc.Expect {
				t.Fatalf("got %q, want %q", got, *tc.Expect)
			}
		})
	}
}

func TestLineNamesOfGrantMatchesContract(t *testing.T) {
	for _, tc := range readLineNames(t).GrantCases {
		t.Run(tc.Why, func(t *testing.T) {
			configs := make([]Config, len(tc.Configs))
			for i, k := range tc.Configs {
				configs[i] = Config{Region: k.Region, Status: "active", UUID: "u", LinksUUID: "u"}
				if k.Label != nil {
					configs[i].UserLabel = *k.Label
				}
				for j := 0; j < k.Lines; j++ {
					configs[i].LinkLines = append(configs[i].LinkLines, fmt.Sprintf("vless://u@h:1#c%d-%d", i, j))
				}
			}
			naming := LineNaming{Brand: tc.Brand}
			if tc.Template != nil {
				naming.Template = *tc.Template
			}
			got := lineNamesOfGrant(configs, naming)
			if len(got) != len(tc.ExpectNames) {
				t.Fatalf("got %d configs, want %d", len(got), len(tc.ExpectNames))
			}
			for i := range got {
				if len(got[i]) != len(tc.ExpectNames[i]) {
					t.Fatalf("config %d: got %d names, want %d", i, len(got[i]), len(tc.ExpectNames[i]))
				}
				for j, want := range tc.ExpectNames[i] {
					if (want == nil) != (got[i][j] == nil) || (want != nil && *want != *got[i][j]) {
						t.Fatalf("config %d line %d: got %v, want %v", i, j, deref(got[i][j]), deref(want))
					}
				}
			}
		})
	}
}

// A config /sub does not serve still takes its number, so a line is named
// alike here and in billing's list, which shows it (ADR-0089 rule 3).
func TestServedLinesAreNamedOverTheWholeGrant(t *testing.T) {
	cfg := func(state, line string) Config {
		return Config{PanelState: state, Status: "active", DesiredRemote: "present", UUID: "u", LinksUUID: "u",
			Region: "de", LinkLines: []string{line}}
	}
	got := servedLines([]Config{cfg("down", "vless://a@h:1#x"), cfg("healthy", "vless://b@h:1#x")}, LineNaming{})
	want := []string{"vless://b@h:1#de%202"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

// A retired config and dead lines take no number: billing's list never shows them.
func TestRetiredAndDeadLinesTakeNoNumber(t *testing.T) {
	c := Config{PanelState: "healthy", Status: "active", DesiredRemote: "present", UUID: "u", LinksUUID: "u",
		Region: "de", LinkLines: []string{"vless://c@h:1#x"}}
	retired := c
	retired.Status = "retired"
	dead := c
	dead.LinksUUID = "old"
	got := servedLines([]Config{retired, dead, c}, LineNaming{})
	if want := []string{"vless://c@h:1#de"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func deref(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}
