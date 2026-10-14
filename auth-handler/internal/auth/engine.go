// Package auth provides a simple RBAC policy engine.
package auth

import (
	"bufio"
	"fmt"
	"os"
	"strings"
)

// Engine holds the loaded role -> permissions mapping.
type Engine struct {
	roles map[string]RolePolicy
	// tenantCeiling is the `grantable:` list plus every permission some role
	// without `*` holds: the most a group or a role a tenant made may claim
	// (F-018-n2, ADR-0144 (2)). Computed once at load.
	tenantCeiling RolePolicy
	// platformSet is every `platform.` key the file lists: what the platform's
	// own group may give its own user (ADR-0139 (4)), outside the ceiling.
	platformSet RolePolicy
}

// PlatformKeyPrefix starts every key of the platform's staff set (AC-1-c).
const PlatformKeyPrefix = "platform."

// The file's two top-level sections (ADR-0144 (2)).
const (
	sectionRoles     = "roles:"
	sectionGrantable = "grantable:"
)

// LoadFile parses a permissions file with the following simple format:
//
//	grantable:
//	  - user.read
//	roles:
//	  user:
//	    permissions:
//	      - self.read
//
// `grantable:` is what a group or tenant-made role may give (ADR-0144 (2)); it
// is no role, so no token can name it. It returns an Engine or an error if
// the file is invalid or missing.
func LoadFile(path string) (*Engine, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("policy: open %s: %w", path, err)
	}
	defer f.Close()

	roles := make(map[string]RolePolicy)
	grantable := RolePolicy{Permissions: make(map[string]struct{})}
	var currentRole string
	inPermissions := false
	inGrantable := false

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		raw := scanner.Text()
		trimmed := strings.TrimSpace(raw)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}

		indent := len(raw) - len(strings.TrimLeft(raw, " "))

		switch {
		case indent == 0 && (trimmed == sectionRoles || trimmed == sectionGrantable):
			inGrantable = trimmed == sectionGrantable
			currentRole, inPermissions = "", false
		case inGrantable && indent == 2 && strings.HasPrefix(trimmed, "- "):
			grantable.Permissions[strings.TrimSpace(strings.TrimPrefix(trimmed, "- "))] = struct{}{}
		case inGrantable:
			return nil, fmt.Errorf("policy: %s: unexpected line: %q", path, raw)
		case indent == 2 && strings.HasSuffix(trimmed, ":"):
			currentRole = strings.TrimSuffix(trimmed, ":")
			roles[currentRole] = RolePolicy{Permissions: make(map[string]struct{})}
			inPermissions = false
		case indent == 4 && trimmed == "permissions:":
			if currentRole == "" {
				return nil, fmt.Errorf("policy: %s: 'permissions:' outside of a role", path)
			}
			inPermissions = true
		case indent >= 6 && strings.HasPrefix(trimmed, "- "):
			if currentRole == "" || !inPermissions {
				return nil, fmt.Errorf("policy: %s: permission listed outside of a role: %q", path, raw)
			}
			perm := strings.TrimSpace(strings.TrimPrefix(trimmed, "- "))
			roles[currentRole].Permissions[perm] = struct{}{}
		default:
			return nil, fmt.Errorf("policy: %s: unexpected line: %q", path, raw)
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("policy: read %s: %w", path, err)
	}
	if len(roles) == 0 {
		return nil, fmt.Errorf("policy: no roles defined in %s", path)
	}

	return &Engine{roles: roles, tenantCeiling: ceilingOf(grantable, roles), platformSet: platformSetOf(roles)}, nil
}

// ceilingOf is the grantable list plus every role that does not hold `*`. The
// wildcard role is left out on purpose: no tenant may hold what only the
// platform owner holds, and `*` itself is never in the union.
func ceilingOf(grantable RolePolicy, roles map[string]RolePolicy) RolePolicy {
	ceiling := RolePolicy{Permissions: make(map[string]struct{})}
	for p := range grantable.Permissions {
		ceiling.Permissions[p] = struct{}{}
	}
	for _, role := range roles {
		if _, all := role.Permissions[AllPermissions]; all {
			continue
		}
		for p := range role.Permissions {
			ceiling.Permissions[p] = struct{}{}
		}
	}
	return ceiling
}

// platformSetOf is every listed key with the platform prefix, in any role.
// Listed by name, so `*` never stands in for one.
func platformSetOf(roles map[string]RolePolicy) RolePolicy {
	set := RolePolicy{Permissions: make(map[string]struct{})}
	for _, role := range roles {
		for p := range role.Permissions {
			if strings.HasPrefix(p, PlatformKeyPrefix) {
				set.Permissions[p] = struct{}{}
			}
		}
	}
	return set
}

// Check verifies that roleName exists and that every permission in
// claimedPermissions is actually granted to that role.
// It returns the list of unauthorized permissions and a boolean indicating success.
//
// roleName is `identity.role.name`, matched exactly: the column is unique
// case-sensitively, so folding case could merge two distinct roles.
func (e *Engine) Check(roleName string, claimedPermissions []string) (unauthorized []string, ok bool) {
	role, exists := e.roles[roleName]
	if !exists {
		return claimedPermissions, false
	}
	for _, p := range claimedPermissions {
		if !role.Allows(p) {
			unauthorized = append(unauthorized, p)
		}
	}
	return unauthorized, len(unauthorized) == 0
}

// CheckTenantRole holds a role a tenant made to the ceiling (F-018-n2). Such a
// role is in no file — tenants create them at runtime — and its name is the
// tenant's choice, so it is never looked up: a tenant role called
// "SuperAdmin" gets the ceiling, not `*`.
func (e *Engine) CheckTenantRole(claimedPermissions []string) (unauthorized []string, ok bool) {
	for _, p := range claimedPermissions {
		if !e.tenantCeiling.Allows(p) {
			unauthorized = append(unauthorized, p)
		}
	}
	return unauthorized, len(unauthorized) == 0
}

// CheckPlatformKeys admits a key of the platform's set listed in the file
// (ADR-0139 (4)). The caller asks it only for a personal token the signer
// marked as the platform owner's tenant; the gate cannot read a tenant's type.
func (e *Engine) CheckPlatformKeys(claimedPermissions []string) (unauthorized []string, ok bool) {
	for _, p := range claimedPermissions {
		if _, listed := e.platformSet.Permissions[p]; !listed {
			unauthorized = append(unauthorized, p)
		}
	}
	return unauthorized, len(unauthorized) == 0
}
