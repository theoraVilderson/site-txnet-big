"use client";

import { useEffect, useMemo, useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { authApi, resellerUserGroupsApi } from "@/lib/auth-api";
import { gatewayAdminApi } from "@/lib/billing-api";
import { GatewaysView } from "../../../../gateways/_components/GatewaysView";
import type { GatewaySurface } from "../../../../gateways/_lib/surface";
import { RESELLER_GATEWAY_KEYS as K, gatewayRefusalKey } from "../../../_lib/gateways";
import { WorkspaceTabs } from "../../../_components/WorkspaceTabs";

/**
 * A reseller's payment gateways (F-066-w4, `panel-web/contract.resellers.md`
 * "A reseller's workspace"). The ambient `/gateways` page's components over
 * the route that names the reseller (F-066-w3): the same list, wizard, editor
 * and quick amounts, pointed at `/api/billing/tenants/:id/gateways`.
 *
 * Why not the ambient page: the owner of a reseller signs in to the platform
 * owner's tenant (ADR-0059), so `/gateways` would configure the **platform's**
 * gateways and answer 200 doing it.
 *
 * No permission is judged here. Billing admits the reseller's owner, a staff
 * seat of it holding `tenant.manage`, or platform support (invariant 21), and
 * a refusal is shown as its own sentence.
 */
export function ResellerGatewaysView({ id }: { id: string }) {
  const { t } = useLocale();
  const [slug, setSlug] = useState<string | null>(null);

  // The name for the title, when the visitor owns it; staff see the plain title.
  useEffect(() => {
    let alive = true;
    authApi
      .ownedResellers()
      .then((r) => alive && setSlug(r.resellers.find((x) => x.id === id)?.slug ?? null))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [id]);

  const surface = useMemo<GatewaySurface>(
    () => ({
      tenantId: id,
      api: gatewayAdminApi(id),
      refusalKey: gatewayRefusalKey,
      // Its own groups, by the path: the ambient list is the session tenant's (F-102-g-d).
      groups: () => resellerUserGroupsApi.list(id),
      chrome: (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-bold text-text-secondary">{slug ? t("common", K.title, { slug }) : t("common", K.titlePlain)}</p>
          <WorkspaceTabs id={id} />
        </div>
      ),
    }),
    // `t` is stable for a language; the chrome is rebuilt when the name arrives.
    [id, slug, t],
  );

  return <GatewaysView surface={surface} />;
}
