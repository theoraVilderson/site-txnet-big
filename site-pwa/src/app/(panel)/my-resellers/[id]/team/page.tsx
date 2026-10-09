import { redirect } from "next/navigation";
import { myResellerGroupsPath } from "@/lib/routes";

/** `/my-resellers/[id]/team` — a tenant's old team page (F-1201-c); its groups now (GR-1-f, ADR-0139 (1)). */
export default async function TenantTeamPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(myResellerGroupsPath(id));
}
