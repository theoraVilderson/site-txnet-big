import { Suspense } from "react";
import { notFound } from "next/navigation";
import { MENU_SECTIONS } from "../../_lib/panel-menu";
import { TableSkeleton } from "../../_components/kit/TableSkeleton";
import { SectionView } from "./_components/SectionView";

/**
 * `/section/[id]` — one menu section's page: where its breadcrumb crumb
 * leads (user, 2026-10-09). Nothing of its own; it lists the menu.
 */
export default async function SectionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Before the stream starts, so an unknown section is a real 404.
  if (!MENU_SECTIONS.some((s) => s.id === id)) notFound();
  return (
    <Suspense
      fallback={
        <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-8">
          <TableSkeleton rows={4} columns={2} />
        </div>
      }
    >
      <SectionView id={id} />
    </Suspense>
  );
}
