"use client";

import { Suspense, type ReactNode } from "react";
import PanelNotFound from "../../not-found";
import { TableSkeleton } from "../../_components/kit/TableSkeleton";
import { useSelfResellerId } from "../../my-resellers/_lib/workspace";

/**
 * `/reseller/…` — a reseller's workspace on its **own** panel domain (F-061-n).
 * The same screens as `/my-resellers/:id/…` (ADR-0064 (4)), handed the
 * session's tenant as the id, so the address bar never carries one.
 *
 * Anywhere else — the platform's panel, or a customer of the reseller — the
 * address does not exist: the panel's 404, not a refusal that admits there is
 * something here. tenant-service still decides every call (invariant 21).
 */
export function SelfWorkspace({
  children,
}: {
  children: (id: string) => ReactNode;
}) {
  // Whose domain this is — the owner's session here is the platform's tenant,
  // so the door's `here` says it, not `me.tenant` (`selfResellerOf`).
  const id = useSelfResellerId();
  const skeleton = (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-8">
      <TableSkeleton rows={4} columns={2} />
    </div>
  );
  if (id === undefined) return skeleton;
  if (id === null) return <PanelNotFound />;
  // The screens read the query (`useSearchParams`), as their `/my-resellers` pages' Suspense allowed.
  return <Suspense fallback={skeleton}>{children(id)}</Suspense>;
}
