import { redirect } from "next/navigation";
import { PANEL_GROUPS } from "@/lib/routes";

/** `/roles` — the old roles page (F-1201-d). Keys are ticked on a group now (GR-1-f, ADR-0139 (1)). */
export default function RolesPage() {
  redirect(PANEL_GROUPS);
}
