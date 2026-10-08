import { useEffect, useState } from "react";
import { authApi, type Me, type OwnedReseller } from "@/lib/auth-api";
import { holdsPermission } from "@/lib/permissions";
import { usePanelSession } from "../../_context/PanelSessionContext";

/**
 * The caller's owned resellers (`GET /auth/handoff`), read once per account and
 * shared by every screen that asks — the sidebar, the workspace guard, each
 * section's links. A failed read is an empty list, never a broken screen.
 */
let cache: { userId: string; list: Promise<OwnedReseller[]> } | null = null;

export function ownedResellersOf(userId: string): Promise<OwnedReseller[]> {
  if (cache?.userId !== userId) {
    cache = {
      userId,
      list: authApi
        .ownedResellers()
        .then((r) => r.resellers)
        .catch(() => []),
    };
  }
  return cache.list;
}

/** For the specs, and after an account switch. */
export function clearOwnedResellersCache() {
  cache = null;
}

type Owned = readonly (Pick<OwnedReseller, "id"> & { here?: boolean; live?: boolean })[];

/**
 * The caller's **own** reseller workspace — the one served at the id-less
 * `/reseller` (F-061-n) on whichever host: its id, `null` for none, `undefined`
 * while unknown.
 *
 * - **A staff seat of a reseller** signs in to the reseller's tenant: `me`
 *   says it — the reseller's owner, or a seat holding `tenant.manage`.
 * - **Its owner** is a user of the platform's tenant everywhere — on the
 *   reseller's own domain too (ADR-0059: the handoff signs the same account
 *   in, branded by the door). There the door's `here` (`GET /auth/handoff`)
 *   names it; on the platform's panel it is the owner's one **live** reseller —
 *   `already_reseller` allows no second — and never a terminated one.
 *
 * The first build read `me.tenant` alone, and the owner — the one person
 * this is for — still saw `/my-resellers/<uuid>`, on its domain and then on
 * the platform's panel (user, 2026-10-08).
 */
export function selfResellerOf(me: Pick<Me, "tenant" | "permissions"> | null, owned: Owned | null): string | null | undefined {
  if (!me) return null;
  if (me.tenant.type === "reseller") {
    return me.tenant.isOwner || holdsPermission(me.permissions, "tenant.manage") ? me.tenant.id : null;
  }
  if (owned === null) return undefined;
  return (owned.find((r) => r.here) ?? owned.find((r) => r.live))?.id ?? null;
}

/**
 * Which reseller's domain the page is on — for anyone signed in there, not
 * only those who may administer it — or `null` on the platform's panel. There
 * `/my-resellers/<id>` is the platform's address and no other reseller is
 * addressed by id; on the platform's panel staff do exactly that.
 */
export function resellerDomainOf(me: Pick<Me, "tenant"> | null, owned: Owned | null): string | null | undefined {
  if (!me) return null;
  if (me.tenant.type === "reseller") return me.tenant.id;
  if (owned === null) return undefined;
  return owned.find((r) => r.here)?.id ?? null;
}

/** The caller's owned resellers, through the shared read; `null` until it answers. */
export function useOwnedResellerList(): OwnedReseller[] | null {
  const { me } = usePanelSession();
  const userId = me?.userId ?? null;
  const [owned, setOwned] = useState<{ userId: string; list: OwnedReseller[] } | null>(null);
  useEffect(() => {
    if (!userId) return;
    let live = true;
    void ownedResellersOf(userId).then((list) => live && setOwned({ userId, list }));
    return () => {
      live = false;
    };
  }, [userId]);
  return owned && owned.userId === userId ? owned.list : null;
}

/** {@link selfResellerOf} for the signed-in caller; `undefined` while `me` or the list is still on its way. */
export function useSelfResellerId(): string | null | undefined {
  const { me, isLoading } = usePanelSession();
  const owned = useOwnedResellerList();
  if (!me) return isLoading ? undefined : null;
  return selfResellerOf(me, owned);
}

/** {@link resellerDomainOf} for the signed-in caller. */
export function useResellerDomainId(): string | null | undefined {
  const { me, isLoading } = usePanelSession();
  const owned = useOwnedResellerList();
  if (!me) return isLoading ? undefined : null;
  return resellerDomainOf(me, owned);
}

/**
 * Is this the caller's own reseller workspace? Then it lives at the id-less
 * `/reseller` and never shows `/my-resellers/<id>`, on either host.
 */
export function useWorkspaceSelf(id: string): boolean {
  return useSelfResellerId() === id;
}
