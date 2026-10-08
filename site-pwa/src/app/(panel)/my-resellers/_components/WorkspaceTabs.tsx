"use client";

import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import {
  myResellerBotPath,
  myResellerBrandingPath,
  myResellerCatalogPath,
  myResellerConsolePath,
  myResellerDomainsPath,
  myResellerGatewaysPath,
  myResellerUsersPath,
} from "@/lib/routes";
import { TabLinks } from "../../_components/kit";
import { useWorkspaceSelf } from "../_lib/workspace";

const K = FrontendI18nKeys.common.resellerOnboarding.tabs;

/**
 * The reseller workspace's tab bar (`contract.ux.md` N8): under the
 * `PageHeader` on every `/my-resellers/:id/…` page (`/reseller/…` on its own
 * domain, F-061-n), one link per section,
 * active by path. It replaced each page's "back to the console" link — the
 * overview tab is that way back, and every other section is one tap away.
 */
export function WorkspaceTabs({ id }: { id: string }) {
  const { t } = useLocale();
  const self = useWorkspaceSelf(id);
  return (
    <TabLinks
      ariaLabel={t("common", K.label)}
      links={[
        { href: myResellerConsolePath(id, self), label: t("common", K.overview), exact: true },
        { href: myResellerUsersPath(id, self), label: t("common", K.users) },
        { href: myResellerCatalogPath(id, self), label: t("common", K.catalog) },
        { href: myResellerDomainsPath(id, self), label: t("common", K.domains) },
        { href: myResellerGatewaysPath(id, self), label: t("common", K.gateways) },
        { href: myResellerBotPath(id, self), label: t("common", K.bot) },
        { href: myResellerBrandingPath(id, self), label: t("common", K.branding) },
      ]}
    />
  );
}
