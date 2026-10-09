"use client";

import { createContext, useContext } from "react";
import { useLocale } from "@/context/LocaleContext";
import { groupsApi, type GroupsApi } from "@/lib/auth-api";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { refusalKey } from "../_lib/user-groups";

// The sheet and field are the catalog page's; they hold no
// catalog rule, and a second copy would drift.
export { Alert, Field, Sheet } from "../../catalog/_components/catalog-ui";

/** The refusal's own sentence, else the generic answer for that error. */
export function useMessage() {
  const { t } = useLocale();
  const errorMessage = useApiErrorMessage();
  return (e: unknown) => {
    const key = refusalKey(e);
    return key ? t("common", key) : errorMessage(e);
  };
}

/**
 * Whose groups the page is on (GR-1-f): `tenantId` null for the session's own,
 * else the tenant its path names; `api` reaches that tenant's routes. Every
 * sheet reads it, so none can write to another tenant's groups by mistake.
 */
export type GroupsScope = { tenantId: string | null; api: GroupsApi };
const ScopeContext = createContext<GroupsScope>({ tenantId: null, api: groupsApi(null) });
export const GroupsScopeProvider = ScopeContext.Provider;
export const useGroupsScope = () => useContext(ScopeContext);
