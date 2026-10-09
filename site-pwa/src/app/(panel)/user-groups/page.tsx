import { redirect } from "next/navigation";
import { PANEL_GROUPS } from "@/lib/routes";

/** `/user-groups` — the groups page's old address (F-114-m); one page now (GR-1-f). */
export default function UserGroupsPage() {
  redirect(PANEL_GROUPS);
}
