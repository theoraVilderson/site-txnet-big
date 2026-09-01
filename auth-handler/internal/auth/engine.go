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
}

// LoadFile parses a permissions file with the following simple format:
// roles:
//
//	admin:
//	  permissions:
//	    - user.read
//	    - user.write
//
// It returns an Engine or an error if the file is invalid or missing.
func LoadFile(path string) (*Engine, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("policy: open %s: %w", path, err)
	}
	defer f.Close()

	roles := make(map[string]RolePolicy)
	var currentRole string
	inPermissions := false

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		raw := scanner.Text()
		trimmed := strings.TrimSpace(raw)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") || trimmed == "roles:" {
			continue
		}

		indent := len(raw) - len(strings.TrimLeft(raw, " "))

		switch {
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

	return &Engine{roles: roles}, nil
}

// Check verifies that roleID exists and that every permission in
// claimedPermissions is actually granted to that role.
// It returns the list of unauthorized permissions and a boolean indicating success.
func (e *Engine) Check(roleID string, claimedPermissions []string) (unauthorized []string, ok bool) {
	role, exists := e.roles[roleID]
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
