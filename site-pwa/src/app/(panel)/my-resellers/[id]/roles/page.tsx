import { redirect } from "next/navigation";
import { myResellerGroupsPath } from "@/lib/routes";

/** `/my-resellers/[id]/roles` — a tenant's old roles page (F-1201-d); its groups now (GR-1-f, ADR-0139 (1)). */
export default async function TenantRolesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(myResellerGroupsPath(id));
}
