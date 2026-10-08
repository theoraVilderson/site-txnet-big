"use client";

import { useEffect, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import PanelNotFound from "../../not-found";
import { selfWorkspacePath } from "@/lib/routes";
import { useResellerDomainId, useSelfResellerId } from "../_lib/workspace";

/**
 * `/my-resellers/:id/…` is the address **platform staff** open a reseller by
 * (ADR-0064 (4)). The caller's own reseller never shows it (F-061-n): on its
 * domain and on the platform's panel alike it moves to the id-less
 * `/reseller/…` twin, same section and query (`useSelfResellerId`). On a
 * reseller's domain any other id is the panel's 404 — no place to address
 * another reseller by id (`useResellerDomainId`).
 *
 * Until both answer nothing is drawn, so the id never flashes in the screen.
 */
export function PlatformOnlyWorkspace({
  id,
  children,
}: {
  id: string;
  children: ReactNode;
}) {
  // The reseller whose domain this is, for this caller — `here` for its owner,
  // whose session is the platform's tenant (`selfResellerOf`).
  const self = useSelfResellerId();
  const domain = useResellerDomainId();
  const pathname = usePathname();
  const search = useSearchParams();
  const router = useRouter();
  const twin = self && self === id ? selfWorkspacePath(pathname, id) : null;

  useEffect(() => {
    if (!twin) return;
    const query = search.toString();
    router.replace(query ? `${twin}?${query}` : twin);
  }, [twin, search, router]);

  if (self === undefined || domain === undefined) return null;
  if (twin) return null;
  // Another reseller by id: the platform's staff do that on its panel, never on a reseller's domain.
  if (domain !== null) return <PanelNotFound />;
  return <>{children}</>;
}
