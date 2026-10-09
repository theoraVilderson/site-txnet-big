"use client";

import { useEffect, useMemo, useState } from "react";
import { holdsAnyResellerKey } from "@/lib/permissions";
import { resellerPurchaseApi, tenantAccessApi } from "@/lib/tenant-api";
import { PANEL_MENU, impersonationMenu, ownTenantOf, visibleMenu, type VisibleMenuEntry } from "../_lib/panel-menu";
import { withResellerMenu } from "../_lib/reseller-menu";
import { useResellerWorkspace } from "../_context/ResellerWorkspaceContext";
import { usePanelSession } from "../_context/PanelSessionContext";

/**
 * Whether the caller holds a live reseller — `GET /purchase/mine`, the one the
 * purchase refuses as `already_reseller` (F-114-c). Not `useOwnedResellers`:
 * that list keeps a terminated reseller, whose owner may buy again. Asked only
 * of a caller the entry could be shown to (`canAsk`); `null` while `me` is
 * unknown or the answer is pending, which hides the entry. A failed read is
 * `false`: the page answers a holder itself (F-019-l). A caller not asked is
 * `false` without a state write, derived at render.
 */
function useHoldsLiveReseller(canAsk: boolean | null): boolean | null {
  const [holds, setHolds] = useState<boolean | null>(null);
  useEffect(() => {
    if (!canAsk) return;
    let live = true;
    resellerPurchaseApi
      .mine()
      .then((r) => live && setHolds(r.reseller !== null))
      .catch(() => live && setHolds(false));
    return () => {
      live = false;
    };
  }, [canAsk]);
  if (canAsk === null) return null;
  return canAsk ? holds : false;
}

/**
 * The door's `canRead` for the caller's own reseller tenant (F-311-ab,
 * `ownTenantOf`), asked only of `tenantId` when given; `null` until it answers
 * for that id. A failed read is `false`: the entry is a shortcut, and hiding it
 * never breaks the sidebar.
 */
function useCanAdminister(tenantId: string | null): boolean | null {
  const [answer, setAnswer] = useState<{ id: string; canRead: boolean } | null>(null);
  useEffect(() => {
    if (tenantId === null) return;
    let live = true;
    tenantAccessApi
      .get(tenantId)
      .then((r) => live && setAnswer({ id: tenantId, canRead: r.canRead }))
      .catch(() => live && setAnswer({ id: tenantId, canRead: false }));
    return () => {
      live = false;
    };
  }, [tenantId]);
  return answer !== null && answer.id === tenantId ? answer.canRead : null;
}

/**
 * The menu as the caller may see it (F-097, UX-1-j) — the sidebar draws it and
 * the palette searches it (UX-1-n, N6), so a page one hides the other never
 * offers. Authority comes off the caller, never off the path: until `me`
 * answers, nothing gated is shown. One menu with the reseller's links merged
 * into its sections (UX-2-a), from the one answer to "whose reseller"
 * (`ResellerWorkspaceProvider`).
 */
export function useVisibleMenu(): VisibleMenuEntry[] {
  const { me } = usePanelSession();
  const held = me?.permissions;
  const tenantType = me?.tenant.type ?? null;
  const isOwner = me?.tenant.isOwner ?? false;
  const ownsReseller = useHoldsLiveReseller(me ? tenantType === "platform_owner" && !isOwner : null);
  // Asked only where it can change the answer: a reseller's user holding a reseller key (AC-1-e2).
  const canAdminister = useCanAdminister(
    me && tenantType === "reseller" && holdsAnyResellerKey(held) ? me.tenant.id : null,
  );
  const tenantId = ownTenantOf(me?.tenant ?? null, canAdminister);
  const { workspace, slug, setup } = useResellerWorkspace();
  const wsId = workspace?.id ?? null;
  const wsSelf = workspace?.self ?? false;
  // A staff seat on its own reseller sees the workspace rows its keys open (AC-1-e2).
  const seatHeld = tenantType === "reseller" && !isOwner && wsId !== null && wsId === me?.tenant.id ? (held ?? []) : null;
  const impersonated = me?.isImpersonated ?? false;
  return useMemo(
    () =>
      // AC-1-i: signed in as someone, the account section alone — no reseller block either.
      impersonated
        ? impersonationMenu(visibleMenu(PANEL_MENU, held ?? [], tenantType, isOwner, false, null))
        : withResellerMenu(
        visibleMenu(PANEL_MENU, held ?? [], tenantType, isOwner, ownsReseller, tenantId),
        wsId === null ? null : { id: wsId, self: wsSelf },
        slug,
        setup,
        tenantId,
        seatHeld,
      ),
    [impersonated, held, tenantType, isOwner, ownsReseller, tenantId, wsId, wsSelf, slug, setup, seatHeld],
  );
}
