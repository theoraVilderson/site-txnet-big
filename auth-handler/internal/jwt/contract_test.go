package jwt

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// fixturePath points at the file written by
// txnet-backend/auth-service/src/app/auth/token.contract.spec.ts.
const fixturePath = "../../../contracts/jwt/ts-to-go.json"

type contractFixture struct {
	Secret string            `json:"secret"`
	Tokens map[string]string `json:"tokens"`
}

func loadFixture(t *testing.T) contractFixture {
	t.Helper()

	raw, err := os.ReadFile(filepath.Clean(fixturePath))
	if os.IsNotExist(err) {
		t.Skipf("contract fixture %s is missing — regenerate it with "+
			"`npx nx test auth-service --testFile=token.contract.spec.ts`", fixturePath)
	}
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}

	var fixture contractFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	if fixture.Secret == "" || len(fixture.Tokens) == 0 {
		t.Fatalf("fixture %s is empty", fixturePath)
	}
	return fixture
}

// The contract: a token minted by TokenService.sign() in TypeScript is read by
// Validate here without error, with every claim intact.
func TestContractAccessTokenFromTypeScript(t *testing.T) {
	fixture := loadFixture(t)

	claims, err := Validate(fixture.Tokens["access"], fixture.Secret)
	if err != nil {
		t.Fatalf("Validate() rejected a token minted by auth-service: %v", err)
	}

	for _, tc := range []struct{ field, got, want string }{
		{"Sub", claims.Sub, "user-contract-1"},
		{"TenantID", claims.TenantID, "tenant-contract-1"},
		{"RoleID", claims.RoleID, "role-contract-1"},
		{"SessionID", claims.SessionID, "session-contract-1"},
	} {
		if tc.got != tc.want {
			t.Errorf("%s = %q, want %q", tc.field, tc.got, tc.want)
		}
	}

	want := []string{"user.read", "billing.read"}
	if len(claims.Permissions) != len(want) {
		t.Fatalf("Permissions = %v, want %v", claims.Permissions, want)
	}
	for i, p := range want {
		if claims.Permissions[i] != p {
			t.Errorf("Permissions[%d] = %q, want %q", i, claims.Permissions[i], p)
		}
	}
}

func TestContractImpersonatedTokenFromTypeScript(t *testing.T) {
	fixture := loadFixture(t)

	claims, err := Validate(fixture.Tokens["impersonated"], fixture.Secret)
	if err != nil {
		t.Fatalf("Validate() rejected an impersonation token: %v", err)
	}
	if !claims.IsImpersonated {
		t.Error("IsImpersonated = false, want true")
	}
	if claims.ImpersonatedBy != "admin-contract-1" {
		t.Errorf("ImpersonatedBy = %q, want %q", claims.ImpersonatedBy, "admin-contract-1")
	}
}

func TestContractRejectedTokensFromTypeScript(t *testing.T) {
	fixture := loadFixture(t)

	t.Run("expired access token", func(t *testing.T) {
		if _, err := Validate(fixture.Tokens["expired"], fixture.Secret); !errors.Is(err, ErrExpired) {
			t.Errorf("Validate() error = %v, want ErrExpired", err)
		}
	})

	// An OTP token carries no sessionId, which is what keeps it out of the
	// ForwardAuth path even though it is signed with the same secret.
	t.Run("otp token", func(t *testing.T) {
		if _, err := Validate(fixture.Tokens["otp"], fixture.Secret); err == nil {
			t.Error("Validate() accepted an OTP token as an access token")
		}
	})

	t.Run("wrong secret", func(t *testing.T) {
		if _, err := Validate(fixture.Tokens["access"], "not-the-secret"); !errors.Is(err, ErrBadSignature) {
			t.Errorf("Validate() error = %v, want ErrBadSignature", err)
		}
	})
}
