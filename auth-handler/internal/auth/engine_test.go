package auth

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// writePolicy drops content into a temp file and returns its path.
func writePolicy(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "permissions.yaml")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	return path
}

// shippedPolicy has the shape of configs/permissions.yaml, indentation included.
const shippedPolicy = `# Role -> allowed permissions. Used as defense-in-depth.
roles:
  admin:
    permissions:
      - user.read
      - user.write
      - user.impersonate
  support:
    permissions:
      - user.read
  user:
    permissions:
      - self.read
      - self.write
`

func TestLoadFileParsesShippedPolicy(t *testing.T) {
	engine, err := LoadFile(writePolicy(t, shippedPolicy))
	if err != nil {
		t.Fatalf("LoadFile() error = %v, want nil", err)
	}

	want := map[string][]string{
		"admin":   {"user.impersonate", "user.read", "user.write"},
		"support": {"user.read"},
		"user":    {"self.read", "self.write"},
	}
	if len(engine.roles) != len(want) {
		t.Fatalf("parsed %d roles, want %d", len(engine.roles), len(want))
	}
	for role, perms := range want {
		policy, ok := engine.roles[role]
		if !ok {
			t.Fatalf("role %q missing from parsed policy", role)
		}
		got := make([]string, 0, len(policy.Permissions))
		for p := range policy.Permissions {
			got = append(got, p)
		}
		sort.Strings(got)
		if strings.Join(got, ",") != strings.Join(perms, ",") {
			t.Errorf("role %q permissions = %v, want %v", role, got, perms)
		}
	}
}

func TestLoadFileIgnoresBlankLinesAndComments(t *testing.T) {
	engine, err := LoadFile(writePolicy(t, `
# leading comment

roles:

  admin:
    permissions:
      # inline comment inside the list
      - user.read

`))
	if err != nil {
		t.Fatalf("LoadFile() error = %v, want nil", err)
	}
	if _, ok := engine.Check("admin", []string{"user.read"}); !ok {
		t.Errorf("admin should hold user.read after parsing")
	}
}

func TestLoadFileMissingFile(t *testing.T) {
	engine, err := LoadFile(filepath.Join(t.TempDir(), "does-not-exist.yaml"))
	if err == nil {
		t.Fatalf("LoadFile() on a missing file returned nil error")
	}
	if engine != nil {
		t.Errorf("LoadFile() returned engine %+v on error, want nil", engine)
	}
}

// A malformed file must fail loudly. Silently returning the roles parsed so far
// would install a half policy, and a half policy denies real users at runtime
// while looking healthy at boot.
func TestLoadFileRejectsMalformedInput(t *testing.T) {
	tests := []struct {
		name    string
		content string
		wantMsg string
	}{
		{
			name:    "role at top level indent",
			content: "roles:\nadmin:\n    permissions:\n      - user.read\n",
			wantMsg: "unexpected line",
		},
		{
			name:    "tab indentation instead of spaces",
			content: "roles:\n\tadmin:\n\t\tpermissions:\n\t\t\t- user.read\n",
			wantMsg: "unexpected line",
		},
		{
			name:    "odd indent on role",
			content: "roles:\n   admin:\n    permissions:\n      - user.read\n",
			wantMsg: "unexpected line",
		},
		{
			name:    "permissions block before any role",
			content: "roles:\n    permissions:\n      - user.read\n",
			wantMsg: "outside of a role",
		},
		{
			name:    "permission item before its permissions block",
			content: "roles:\n  admin:\n      - user.read\n",
			wantMsg: "outside of a role",
		},
		{
			name:    "permission item with no role at all",
			content: "roles:\n      - user.read\n",
			wantMsg: "outside of a role",
		},
		{
			name:    "list item missing the space after the dash",
			content: "roles:\n  admin:\n    permissions:\n      -user.read\n",
			wantMsg: "unexpected line",
		},
		{
			name:    "stray prose",
			content: "roles:\n  admin:\n    permissions:\n      - user.read\nthis is not policy\n",
			wantMsg: "unexpected line",
		},
		{
			name:    "empty file",
			content: "",
			wantMsg: "no roles defined",
		},
		{
			name:    "header only",
			content: "roles:\n",
			wantMsg: "no roles defined",
		},
		{
			name:    "comments only",
			content: "# nothing here yet\n",
			wantMsg: "no roles defined",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			engine, err := LoadFile(writePolicy(t, tc.content))
			if err == nil {
				t.Fatalf("LoadFile() error = nil, want an error mentioning %q", tc.wantMsg)
			}
			if !strings.Contains(err.Error(), tc.wantMsg) {
				t.Errorf("LoadFile() error = %q, want it to mention %q", err, tc.wantMsg)
			}
			if engine != nil {
				t.Errorf("LoadFile() returned a partial engine %+v, want nil", engine)
			}
		})
	}
}

// A path that opens but cannot be read must surface the read error, not an
// empty policy. On Linux a directory opens fine and fails on the first read.
func TestLoadFileUnreadableSource(t *testing.T) {
	engine, err := LoadFile(t.TempDir())
	if err == nil {
		t.Fatalf("LoadFile() on a directory returned nil error")
	}
	if !strings.Contains(err.Error(), "policy:") {
		t.Errorf("LoadFile() error = %q, want it tagged with the policy prefix", err)
	}
	if engine != nil {
		t.Errorf("LoadFile() returned engine %+v on error, want nil", engine)
	}
}

// A role declared with no permissions is well-formed, and must grant nothing.
func TestLoadFileEmptyRoleGrantsNothing(t *testing.T) {
	engine, err := LoadFile(writePolicy(t, "roles:\n  ghost:\n    permissions:\n"))
	if err != nil {
		t.Fatalf("LoadFile() error = %v, want nil", err)
	}
	unauthorized, ok := engine.Check("ghost", []string{"user.read"})
	if ok {
		t.Errorf("Check() ok = true for a role with no permissions")
	}
	if len(unauthorized) != 1 || unauthorized[0] != "user.read" {
		t.Errorf("Check() unauthorized = %v, want [user.read]", unauthorized)
	}
}

// A repeated role header resets the role rather than merging into it, so the
// last block wins. Pinned so the behaviour cannot change unnoticed.
func TestLoadFileRepeatedRoleKeepsLastBlock(t *testing.T) {
	engine, err := LoadFile(writePolicy(t, `roles:
  admin:
    permissions:
      - user.read
  admin:
    permissions:
      - user.write
`))
	if err != nil {
		t.Fatalf("LoadFile() error = %v, want nil", err)
	}
	if _, ok := engine.Check("admin", []string{"user.write"}); !ok {
		t.Errorf("admin should hold user.write from the last block")
	}
	if _, ok := engine.Check("admin", []string{"user.read"}); ok {
		t.Errorf("admin should not still hold user.read from the discarded block")
	}
}

func TestCheck(t *testing.T) {
	engine, err := LoadFile(writePolicy(t, shippedPolicy))
	if err != nil {
		t.Fatalf("LoadFile() error = %v, want nil", err)
	}

	tests := []struct {
		name             string
		role             string
		claimed          []string
		wantOK           bool
		wantUnauthorized []string
	}{
		{
			name:    "granted permission",
			role:    "support",
			claimed: []string{"user.read"},
			wantOK:  true,
		},
		{
			name:    "subset of a larger role",
			role:    "admin",
			claimed: []string{"user.read", "user.write"},
			wantOK:  true,
		},
		{
			name:    "no claims at all",
			role:    "user",
			claimed: nil,
			wantOK:  true,
		},
		{
			name:             "permission outside the role scope",
			role:             "support",
			claimed:          []string{"user.write"},
			wantUnauthorized: []string{"user.write"},
		},
		{
			name:             "one granted, one out of scope",
			role:             "support",
			claimed:          []string{"user.read", "user.impersonate"},
			wantUnauthorized: []string{"user.impersonate"},
		},
		{
			name:             "permissions of a different role entirely",
			role:             "user",
			claimed:          []string{"user.read", "user.write"},
			wantUnauthorized: []string{"user.read", "user.write"},
		},
		{
			name:             "unknown permission name",
			role:             "admin",
			claimed:          []string{"billing.refund"},
			wantUnauthorized: []string{"billing.refund"},
		},
		{
			name:             "unknown role",
			role:             "root",
			claimed:          []string{"user.read"},
			wantUnauthorized: []string{"user.read"},
		},
		{
			name:             "unknown role claiming nothing is still denied",
			role:             "root",
			claimed:          nil,
			wantUnauthorized: nil,
		},
		{
			name:             "empty role id",
			role:             "",
			claimed:          []string{"self.read"},
			wantUnauthorized: []string{"self.read"},
		},
		{
			name:             "role id is case sensitive",
			role:             "Admin",
			claimed:          []string{"user.read"},
			wantUnauthorized: []string{"user.read"},
		},
		{
			name:             "permission name is case sensitive",
			role:             "admin",
			claimed:          []string{"User.Read"},
			wantUnauthorized: []string{"User.Read"},
		},
		{
			name:             "empty permission string is never granted",
			role:             "admin",
			claimed:          []string{""},
			wantUnauthorized: []string{""},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			unauthorized, ok := engine.Check(tc.role, tc.claimed)
			if ok != tc.wantOK {
				t.Errorf("Check(%q, %v) ok = %v, want %v", tc.role, tc.claimed, ok, tc.wantOK)
			}
			if strings.Join(unauthorized, ",") != strings.Join(tc.wantUnauthorized, ",") {
				t.Errorf("Check(%q, %v) unauthorized = %v, want %v",
					tc.role, tc.claimed, unauthorized, tc.wantUnauthorized)
			}
		})
	}
}

// An unknown role must be refused on identity, not on the claim list — a caller
// that sends no permissions must not slip through the "nothing unauthorized" gate.
func TestCheckUnknownRoleIsDeniedRegardlessOfClaims(t *testing.T) {
	engine, err := LoadFile(writePolicy(t, shippedPolicy))
	if err != nil {
		t.Fatalf("LoadFile() error = %v, want nil", err)
	}
	for _, claimed := range [][]string{nil, {}, {"user.read"}} {
		if _, ok := engine.Check("nope", claimed); ok {
			t.Errorf("Check() on unknown role with claims %v returned ok = true", claimed)
		}
	}
}

// Check must not retain or mutate the caller's slice.
func TestCheckDoesNotMutateClaims(t *testing.T) {
	engine, err := LoadFile(writePolicy(t, shippedPolicy))
	if err != nil {
		t.Fatalf("LoadFile() error = %v, want nil", err)
	}
	claimed := []string{"user.read", "user.write", "billing.refund"}
	before := strings.Join(claimed, ",")
	engine.Check("support", claimed)
	if strings.Join(claimed, ",") != before {
		t.Errorf("Check() mutated its argument: %v, want %s", claimed, before)
	}
}
