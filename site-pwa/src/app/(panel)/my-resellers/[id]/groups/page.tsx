import { GroupsView } from "../../../groups/_components/GroupsView";

/**
 * `/my-resellers/[id]/groups` — a tenant's groups by its path (GR-1-f, GR-1-d,
 * ADR-0139 (5)): a reseller's for its owner and its people who hold
 * `user_group.manage`, and for the platform's staff. The services admit by
 * the path; the page shows their refusal otherwise.
 */
export default async function TenantGroupsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <GroupsView tenantId={id} />;
}
