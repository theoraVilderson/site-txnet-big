"use client";

import { useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ownTenantRedirect } from "./users";

/**
 * An old `/my-resellers/<session tenant>/{users,team,roles}[/…]` address — a
 * bookmark, a link from before the session's own pages — is replaced by its
 * `/users`, `/team` or `/roles` one, query kept. Nothing on `own` pages.
 */
export function useOwnTenantRedirect(own: boolean, sessionTenantId: string | undefined) {
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const query = useSearchParams()?.toString() ?? "";
  const target = own ? null : ownTenantRedirect(pathname, sessionTenantId);
  useEffect(() => {
    if (target) router.replace(query ? `${target}?${query}` : target);
  }, [router, target, query]);
}
