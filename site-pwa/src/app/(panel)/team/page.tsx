import { redirect } from "next/navigation";
import { PANEL_GROUPS } from "@/lib/routes";

/** `/team` — the old team page (F-1201-c). Access is given by groups alone now (GR-1-f, ADR-0139 (1)). */
export default function TeamPage() {
  redirect(PANEL_GROUPS);
}
