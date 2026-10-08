// Package jwt provides functions for validating JSON Web Tokens (JWT)
// signed with HMAC-SHA256.
package jwt

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// Errors returned by Validate.
var (
	ErrMalformedToken = errors.New("jwt: malformed token")
	ErrBadSignature   = errors.New("jwt: invalid signature")
	ErrExpired        = errors.New("jwt: token expired or missing required claims")
)

// Claims represents the custom JWT claims expected from the auth service.
type Claims struct {
	Sub      string `json:"sub"`
	TenantID string `json:"tenantId"`
	RoleID   string `json:"roleId"`
	// RoleName is what the policy file is keyed by. RoleID is a database
	// UUID that differs on every seed, so it can never address a role in a
	// file checked into the repo (ADR-0037).
	RoleName string `json:"roleName"`
	// RoleScope is "tenant" for a role a tenant made, which the policy checks
	// by its grants against the ceiling and never by name (F-018-n2). Anything
	// else — "system", or absent on an older token — is looked up by name.
	RoleScope   string   `json:"roleScope"`
	SessionID   string   `json:"sessionId"`
	Permissions []string `json:"permissions"`
	// PermHash fingerprints Permissions as they were when the token was minted.
	// The gate compares it to the role's current fingerprint in Redis, so a
	// changed role is refused at once rather than after the token expires
	// (ADR-0043). Empty on a token minted before that shipped.
	PermHash       string `json:"permHash"`
	// Restricted marks a restricted account (`suspended`, ADR-0133): its
	// permissions are empty and the gate admits it only on its allow-list.
	Restricted     bool   `json:"restricted"`
	IsImpersonated bool   `json:"isImpersonated"`
	ImpersonatedBy string `json:"impersonatedBy"`
	Exp            int64  `json:"exp"`
}

// Validate checks the JWT signature and required claims.
// It always verifies using HMAC-SHA256 regardless of the token's header algorithm,
// preventing alg confusion attacks.
func Validate(token, secret string) (Claims, error) {
	var claims Claims

	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return claims, ErrMalformedToken
	}

	mac := hmac.New(sha256.New, []byte(secret))
	if _, err := mac.Write([]byte(parts[0] + "." + parts[1])); err != nil {
		return claims, err
	}
	expected := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if subtle.ConstantTimeCompare([]byte(expected), []byte(parts[2])) != 1 {
		return claims, ErrBadSignature
	}

	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return claims, ErrMalformedToken
	}
	if err := json.Unmarshal(raw, &claims); err != nil {
		return claims, ErrMalformedToken
	}

	if claims.Sub == "" || claims.SessionID == "" || claims.Exp <= time.Now().Unix() {
		return claims, ErrExpired
	}

	return claims, nil
}

// RoleScopeTenant marks a role a tenant made (F-018-n2). The TypeScript twin
// is `TokenService`'s `roleScope`.
const RoleScopeTenant = "tenant"
