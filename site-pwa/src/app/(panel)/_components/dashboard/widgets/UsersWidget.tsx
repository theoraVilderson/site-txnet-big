"use client";

import { Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { resellerUsersApi } from "@/lib/auth-api";
import { myResellerUsersPath } from "@/lib/routes";
import { usePanelSession } from "../../../_context/PanelSessionContext";
import { useWidgetSource } from "../useWidgetSource";
import { WidgetBody } from "../WidgetFrame";
import { FooterLink } from "../parts";

const D = FrontendI18nKeys.common.dashboard;

/**
 * Users (UX-1-r, D5): how many the caller's tenant has, and a search that opens
 * the users page on it (`?q=`). Drawn only while the menu shows that page, so
 * the tenant is the caller's own — the one the page is opened on (F-311-ab).
 */
export default function UsersWidget() {
  const { t, lang } = useLocale();
  const router = useRouter();
  const { me } = usePanelSession();
  const tenantId = me?.tenant.id ?? null;
  // On a reseller's own domain its users page has no id in the address (F-061-n).
  const self = me?.tenant.type === "reseller";
  const [q, setQ] = useState("");
  const source = useWidgetSource(
    "users",
    async () => {
      if (!tenantId) throw new Error("no tenant");
      return (await resellerUsersApi.list(tenantId, { page: 1, pageSize: 1 })).total;
    },
    [tenantId],
  );
  return (
    <WidgetBody source={source}>
      {(total) => (
        <div className="flex h-full flex-col gap-3">
          <p className="text-2xl font-black tabular-nums text-text-primary">{total.toLocaleString(lang === "fa" ? "fa-IR" : "en-US")}</p>
          <form
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              const query = q.trim();
              if (tenantId) router.push(query ? `${myResellerUsersPath(tenantId, self)}?q=${encodeURIComponent(query)}` : myResellerUsersPath(tenantId, self));
            }}
            className="relative"
          >
            <Search size={16} aria-hidden className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-text-secondary" />
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label={t("common", D.users.search)}
              placeholder={t("common", D.users.search)}
              className="h-10 w-full rounded-xl border border-card-border bg-bg-inner ps-9 pe-3 text-sm text-text-primary outline-none focus:border-primary"
            />
          </form>
          {tenantId && <FooterLink href={myResellerUsersPath(tenantId, self)}>{t("common", D.users.open)}</FooterLink>}
        </div>
      )}
    </WidgetBody>
  );
}
