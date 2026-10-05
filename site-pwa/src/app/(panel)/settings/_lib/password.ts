/**
 * The register form's password rules, said while typing (UX-1-u,
 * `contract.ux.md` S4). The same five as auth-service's `strongPasswordSchema`
 * — which stays the authority: this only says early what the server would
 * refuse. The one rule it cannot see (no name, username or phone inside) is
 * the server's refusal, shown inline.
 */
export type PasswordRule = "length" | "lower" | "upper" | "digit" | "special";

export const PASSWORD_RULES: readonly PasswordRule[] = ["length", "lower", "upper", "digit", "special"];

export function passwordChecks(password: string): Record<PasswordRule, boolean> {
  return {
    length: password.length >= 8 && password.length <= 72,
    lower: /[a-z]/.test(password),
    upper: /[A-Z]/.test(password),
    digit: /[0-9]/.test(password),
    special: /[^A-Za-z0-9]/.test(password),
  };
}

/** 0 (too weak) to 4 (strong): one step per rule held past the first; all five is 4. */
export function passwordStrength(password: string): 0 | 1 | 2 | 3 | 4 {
  const held = PASSWORD_RULES.filter((rule) => passwordChecks(password)[rule]).length;
  return Math.max(0, held - 1) as 0 | 1 | 2 | 3 | 4;
}

export function meetsPasswordRules(password: string): boolean {
  return passwordStrength(password) === 4;
}
