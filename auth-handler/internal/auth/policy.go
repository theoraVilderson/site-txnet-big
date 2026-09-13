package auth

// AllPermissions, granted to a role, allows it every permission — including
// one no file names yet (F-101-d, ADR-0043 as amended). Only the bare "*" is a
// wildcard; "user.*" is an ordinary name. The TypeScript twin is
// `ALL_PERMISSIONS` in shared-core's `http/permissions.ts`.
const AllPermissions = "*"

// RolePolicy describes what a given role is allowed to do.
type RolePolicy struct {
	Permissions map[string]struct{}
}

// Allows reports whether the role is permitted the given permission.
func (r RolePolicy) Allows(permission string) bool {
	if _, all := r.Permissions[AllPermissions]; all {
		return true
	}
	_, ok := r.Permissions[permission]
	return ok
}
