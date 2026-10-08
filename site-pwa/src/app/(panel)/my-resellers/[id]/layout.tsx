import { Suspense, type ReactNode } from "react";
import { PlatformOnlyWorkspace } from "../_components/PlatformOnlyWorkspace";

/**
 * Every `/my-resellers/:id/…` screen is the platform panel's (F-061-n): on a
 * reseller's own domain it moves to `/reseller/…`. Suspense because the move
 * keeps the query (`useSearchParams`).
 */
export default async function ResellerWorkspaceLayout({
  params,
  children,
}: {
  params: Promise<{ id: string }>;
  children: ReactNode;
}) {
  const { id } = await params;
  return (
    <Suspense fallback={null}>
      <PlatformOnlyWorkspace id={id}>{children}</PlatformOnlyWorkspace>
    </Suspense>
  );
}
