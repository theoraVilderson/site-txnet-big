"use client";

import { useEffect, useState } from "react";
import { audienceGroups, type AudienceGroup } from "@/lib/auth-api";

/** The picker's groups: loading (`null`), unreadable (`"failed"`), or read. */
export type AudienceGroups = AudienceGroup[] | null | "failed";

/**
 * The groups this caller may aim at (GR-1-x, ADR-0143), read once per scope:
 * `null` the session's tenant, or a reseller by its path. The server's own rule
 * decides the list, so a save never meets a group the picker offered and it refuses.
 */
export function useAudienceGroups(tenantId: string | null): AudienceGroups {
  // Kept with the tenant it was read for, so a change of scope reads as loading, never as the old list.
  const [read, setRead] = useState<{ tenantId: string | null; groups: AudienceGroups }>({ tenantId, groups: null });
  useEffect(() => {
    let live = true;
    audienceGroups(tenantId).then(
      (list) => live && setRead({ tenantId, groups: list }),
      () => live && setRead({ tenantId, groups: "failed" }),
    );
    return () => {
      live = false;
    };
  }, [tenantId]);
  return read.tenantId === tenantId ? read.groups : null;
}
