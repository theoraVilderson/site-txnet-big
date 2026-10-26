// auth-service's client, one module per domain under `./auth/` (FE-1-h).
// This file is the address every caller and every spec's `vi.mock` names, so
// it re-exports them all and assembles `authApi` from their parts; the token,
// the shared refresh and the transport are `./auth/credential.ts`'s.
import { accountCalls } from "./auth/account";
import { sessionCalls } from "./auth/credential";
import { ownerSetupCalls } from "./auth/owner-setup";
import { signInCalls } from "./auth/sign-in";

export * from "./auth/account";
export { ImpersonationEnded, type Impersonation } from "./auth/credential";
export * from "./auth/reseller-users";
export * from "./auth/restrictions";
export * from "./auth/roles";
export * from "./auth/sign-in";
export * from "./auth/owner-setup";
export * from "./auth/support-consent";
export * from "./auth/user-groups";

/** Every auth call for the caller's own session and account, one object as before the split. */
export const authApi = {
  ...signInCalls,
  ...sessionCalls,
  ...accountCalls,
  ...ownerSetupCalls,
};
