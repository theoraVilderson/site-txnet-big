"use client";

import { useSyncExternalStore } from "react";
import { authApi, type Impersonation } from "@/lib/auth-api";

/** Whom this tab is signed in as (AC-1-i), or null for the caller's own account. */
export function useImpersonation(): Impersonation | null {
  return useSyncExternalStore(authApi.onImpersonationChange, authApi.impersonation, () => null);
}
