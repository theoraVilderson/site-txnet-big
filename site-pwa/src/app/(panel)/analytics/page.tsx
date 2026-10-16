import { AnalyticsView } from "./_components/AnalyticsView";

/**
 * `/analytics` — the session's tenant's analytics (F-1001-d): the platform's
 * for its staff, a reseller's for its seats. A server shell around one client
 * view; billing admits by `analytics.read` and the view shows its refusal.
 */
export default function AnalyticsPage() {
  return <AnalyticsView />;
}
