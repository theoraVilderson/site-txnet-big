import { redirect } from "next/navigation";
import { myResellerGroupsPath } from "@/lib/routes";

/** `/reseller/roles` on a reseller's own domain — the old roles page (F-061-n); its groups now (GR-1-f, ADR-0139 (1)). */
export default function Page() {
  redirect(myResellerGroupsPath("", true));
}
