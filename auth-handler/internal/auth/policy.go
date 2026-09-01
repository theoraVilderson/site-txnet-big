package auth

// RolePolicy describes what a given role is allowed to do.
type RolePolicy struct {
	Permissions map[string]struct{}
}

// Allows reports whether the role is permitted the given permission.
func (r RolePolicy) Allows(permission string) bool {
	_, ok := r.Permissions[permission]
	return ok
}
