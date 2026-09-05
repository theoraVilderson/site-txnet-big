package jwt

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

const testSecret = "unit-test-access-secret"

func b64(t *testing.T, v any) string {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}

func b64s(s string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(s))
}

func sign(header, payload, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(header + "." + payload))
	return header + "." + payload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// validClaims mirrors what auth-service puts in an access token.
func validClaims(exp int64) map[string]any {
	return map[string]any{
		"sub":         "user-1",
		"tenantId":    "tenant-1",
		"roleId":      "role-1",
		"sessionId":   "session-1",
		"permissions": []string{"user.read", "billing.read"},
		"iat":         time.Now().Unix(),
		"exp":         exp,
	}
}

func validToken(t *testing.T) string {
	t.Helper()
	header := b64(t, map[string]string{"alg": "HS256", "typ": "JWT"})
	return sign(header, b64(t, validClaims(time.Now().Add(time.Hour).Unix())), testSecret)
}

func TestValidateAcceptsWellFormedToken(t *testing.T) {
	claims, err := Validate(validToken(t), testSecret)
	if err != nil {
		t.Fatalf("Validate() error = %v, want nil", err)
	}

	if claims.Sub != "user-1" {
		t.Errorf("Sub = %q, want %q", claims.Sub, "user-1")
	}
	if claims.TenantID != "tenant-1" {
		t.Errorf("TenantID = %q, want %q", claims.TenantID, "tenant-1")
	}
	if claims.SessionID != "session-1" {
		t.Errorf("SessionID = %q, want %q", claims.SessionID, "session-1")
	}
	if len(claims.Permissions) != 2 || claims.Permissions[0] != "user.read" {
		t.Errorf("Permissions = %v, want [user.read billing.read]", claims.Permissions)
	}
	if claims.IsImpersonated {
		t.Error("IsImpersonated = true, want false for a plain access token")
	}
}

func TestValidateCarriesImpersonation(t *testing.T) {
	header := b64(t, map[string]string{"alg": "HS256", "typ": "JWT"})
	payload := validClaims(time.Now().Add(time.Hour).Unix())
	payload["isImpersonated"] = true
	payload["impersonatedBy"] = "admin-9"

	claims, err := Validate(sign(header, b64(t, payload), testSecret), testSecret)
	if err != nil {
		t.Fatalf("Validate() error = %v, want nil", err)
	}
	if !claims.IsImpersonated || claims.ImpersonatedBy != "admin-9" {
		t.Errorf("impersonation = (%v, %q), want (true, admin-9)",
			claims.IsImpersonated, claims.ImpersonatedBy)
	}
}

func TestValidateMalformedToken(t *testing.T) {
	header := b64(t, map[string]string{"alg": "HS256", "typ": "JWT"})
	good := validToken(t)

	tests := []struct {
		name  string
		token string
	}{
		{"empty string", ""},
		{"no separators", "notatoken"},
		{"two segments", header + "." + b64s(`{"sub":"user-1"}`)},
		{"four segments", good + ".extra"},
		{"payload is not base64url", sign(header, "@@@@", testSecret)},
		{"payload uses standard base64 alphabet", sign(header, "a+b/c=", testSecret)},
		{"payload is valid base64 but not JSON", sign(header, b64s("definitely not json {"), testSecret)},
		{"payload is truncated JSON", sign(header, b64s(`{"sub":`), testSecret)},
		{"payload is a JSON array", sign(header, b64s(`["sub","user-1"]`), testSecret)},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := Validate(tc.token, testSecret); !errors.Is(err, ErrMalformedToken) {
				t.Errorf("Validate() error = %v, want ErrMalformedToken", err)
			}
		})
	}
}

func TestValidateRejectsBadSignature(t *testing.T) {
	header := b64(t, map[string]string{"alg": "HS256", "typ": "JWT"})
	payload := b64(t, validClaims(time.Now().Add(time.Hour).Unix()))
	good := sign(header, payload, testSecret)
	signature := strings.Split(good, ".")[2]

	tests := []struct {
		name  string
		token string
	}{
		{"flipped first byte", header + "." + payload + "." + flip(signature)},
		{"truncated signature", header + "." + payload + "." + signature[:10]},
		{"empty signature", header + "." + payload + "."},
		{"over-long signature", header + "." + payload + "." + signature + signature},
		{"single character", header + "." + payload + ".x"},
		// Three empty segments: this gets past the arity check, so the
		// signature comparison is what has to reject it.
		{"only separators", ".."},
		{"signed with another secret", sign(header, payload, "someone-elses-secret")},
		{"payload swapped, signature kept", header + "." +
			b64s(`{"sub":"attacker","sessionId":"s","exp":4102444800}`) + "." + signature},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := Validate(tc.token, testSecret); !errors.Is(err, ErrBadSignature) {
				t.Errorf("Validate() error = %v, want ErrBadSignature", err)
			}
		})
	}
}

// The header is never parsed, so no value of `alg` can change how the token is
// verified. Both directions are checked: a forged "none" token must fail, and a
// properly HMAC-signed token must pass even when its header lies.
func TestValidateIgnoresHeaderAlg(t *testing.T) {
	payload := b64(t, validClaims(time.Now().Add(time.Hour).Unix()))

	t.Run("unsigned alg=none token is rejected", func(t *testing.T) {
		header := b64(t, map[string]string{"alg": "none", "typ": "JWT"})
		if _, err := Validate(header+"."+payload+".", testSecret); !errors.Is(err, ErrBadSignature) {
			t.Errorf("Validate() error = %v, want ErrBadSignature", err)
		}
	})

	t.Run("alg=none token signed with the secret is still verified as HS256", func(t *testing.T) {
		header := b64(t, map[string]string{"alg": "none", "typ": "JWT"})
		if _, err := Validate(sign(header, payload, testSecret), testSecret); err != nil {
			t.Errorf("Validate() error = %v, want nil — the header must be ignored", err)
		}
	})

	t.Run("alg=RS256 header does not switch verification", func(t *testing.T) {
		header := b64(t, map[string]string{"alg": "RS256", "typ": "JWT"})
		if _, err := Validate(sign(header, payload, testSecret), testSecret); err != nil {
			t.Errorf("Validate() error = %v, want nil — the header must be ignored", err)
		}
		if _, err := Validate(header+"."+payload+".fake", testSecret); !errors.Is(err, ErrBadSignature) {
			t.Errorf("Validate() error = %v, want ErrBadSignature", err)
		}
	})

	t.Run("header is not required to be JSON at all", func(t *testing.T) {
		if _, err := Validate(sign(b64s("not json"), payload, testSecret), testSecret); err != nil {
			t.Errorf("Validate() error = %v, want nil — the header is opaque", err)
		}
	})
}

func TestValidateRejectsExpiredOrIncompleteClaims(t *testing.T) {
	header := b64(t, map[string]string{"alg": "HS256", "typ": "JWT"})

	tests := []struct {
		name   string
		mutate func(map[string]any)
	}{
		{"exp in the past", func(c map[string]any) { c["exp"] = time.Now().Add(-time.Second).Unix() }},
		{"exp exactly now", func(c map[string]any) { c["exp"] = time.Now().Unix() }},
		{"exp missing", func(c map[string]any) { delete(c, "exp") }},
		{"sub empty", func(c map[string]any) { c["sub"] = "" }},
		{"sub missing", func(c map[string]any) { delete(c, "sub") }},
		{"sessionId empty", func(c map[string]any) { c["sessionId"] = "" }},
		{"sessionId missing", func(c map[string]any) { delete(c, "sessionId") }},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			claims := validClaims(time.Now().Add(time.Hour).Unix())
			tc.mutate(claims)

			if _, err := Validate(sign(header, b64(t, claims), testSecret), testSecret); !errors.Is(err, ErrExpired) {
				t.Errorf("Validate() error = %v, want ErrExpired", err)
			}
		})
	}
}

// A single-purpose token (OTP login, password reset) is signed with the same
// secret as an access token, so the gateway can only tell them apart by their
// claims. auth-service leaves sessionId empty on those, which is what keeps
// them out of the ForwardAuth path.
func TestValidateRejectsPurposedTokens(t *testing.T) {
	header := b64(t, map[string]string{"alg": "HS256", "typ": "JWT"})

	for _, purpose := range []string{"otp_login", "password_reset"} {
		t.Run(purpose, func(t *testing.T) {
			claims := map[string]any{
				"sub":         "user-1",
				"tenantId":    "",
				"roleId":      "",
				"sessionId":   "",
				"permissions": []string{},
				"purpose":     purpose,
				"exp":         time.Now().Add(5 * time.Minute).Unix(),
			}

			if _, err := Validate(sign(header, b64(t, claims), testSecret), testSecret); err == nil {
				t.Fatalf("Validate() accepted a %s token as an access token", purpose)
			}
		})
	}
}

func TestValidateEmptySecret(t *testing.T) {
	// A misconfigured gateway must not turn into an open door: a token signed
	// with the real secret has to fail when the gateway holds a different one.
	if _, err := Validate(validToken(t), ""); !errors.Is(err, ErrBadSignature) {
		t.Errorf("Validate() error = %v, want ErrBadSignature", err)
	}
}

func flip(s string) string {
	if s == "" {
		return "x"
	}
	first := byte('A')
	if s[0] == 'A' {
		first = 'B'
	}
	return string(first) + s[1:]
}

func BenchmarkValidate(b *testing.B) {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	raw, _ := json.Marshal(map[string]any{
		"sub": "user-1", "sessionId": "session-1",
		"exp": time.Now().Add(time.Hour).Unix(),
	})
	token := sign(header, base64.RawURLEncoding.EncodeToString(raw), testSecret)

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := Validate(token, testSecret); err != nil {
			b.Fatal(err)
		}
	}
}
