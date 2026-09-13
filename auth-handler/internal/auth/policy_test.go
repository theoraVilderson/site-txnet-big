package auth

import "testing"

func TestRolePolicyAllows(t *testing.T) {
	policy := RolePolicy{Permissions: map[string]struct{}{
		"user.read": {},
		"":          {},
	}}

	tests := []struct {
		name       string
		permission string
		want       bool
	}{
		{name: "granted", permission: "user.read", want: true},
		{name: "not granted", permission: "user.write", want: false},
		{name: "case sensitive", permission: "User.Read", want: false},
		{name: "prefix is not a match", permission: "user", want: false},
		{name: "explicitly stored empty key", permission: "", want: true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := policy.Allows(tc.permission); got != tc.want {
				t.Errorf("Allows(%q) = %v, want %v", tc.permission, got, tc.want)
			}
		})
	}
}

// F-101-d: a role granted the bare "*" allows every permission, including one
// no file names yet. Only the bare "*" — a prefix pattern grants nothing.
func TestRolePolicyAllPermissions(t *testing.T) {
	all := RolePolicy{Permissions: map[string]struct{}{AllPermissions: {}}}
	for _, p := range []string{"user.read", "settlement.manage", "feature.added.tomorrow"} {
		if !all.Allows(p) {
			t.Errorf("a role granted %q refused %q", AllPermissions, p)
		}
	}

	pattern := RolePolicy{Permissions: map[string]struct{}{"user.*": {}}}
	if pattern.Allows("user.read") {
		t.Errorf("\"user.*\" was treated as a wildcard")
	}
}

// The zero value must deny rather than panic — a role parsed with no
// permissions block leaves the map empty, and a nil map is one refactor away.
func TestRolePolicyZeroValueDenies(t *testing.T) {
	var policy RolePolicy
	if policy.Allows("user.read") {
		t.Errorf("zero-value RolePolicy granted user.read")
	}
	if policy.Allows("") {
		t.Errorf("zero-value RolePolicy granted the empty permission")
	}
}
