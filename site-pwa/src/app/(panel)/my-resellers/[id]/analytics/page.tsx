import { AnalyticsView } from "../../../analytics/_components/AnalyticsView";

/**
 * `/my-resellers/[id]/analytics` — a reseller's analytics by the path
 * (F-1001-d): the `/analytics` view handed that reseller. Its owner signs in to
 * the platform's tenant (ADR-0059), so the ambient page would read the
 * platform's; the platform's staff see a reseller at tier A (billing hides cells
 * under 5 people).
 */
export default async function ResellerAnalyticsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AnalyticsView tenantId={id} />;
}
