"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { authApi } from "@/lib/auth-api";
import { gatewayAdminApi } from "@/lib/billing-api";
import { myResellerConsolePath } from "@/lib/routes";
import { GatewaysView } from "../../../../gateways/_components/GatewaysView";
import type { GatewaySurface } from "../../../../gateways/_lib/surface";
import { RESELLER_GATEWAY_KEYS as K, gatewayRefusalKey } from "../../../_lib/gateways";

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
      chrome: (
        <div>
          <Link
            href={myResellerConsolePath(id)}
            className="mb-2 -ms-2 inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-bold text-text-secondary transition-colors hover:text-text-primary"
          >
            <ArrowRight size={12} className="ltr:rotate-180" aria-hidden />
            {t("common", K.backToConsole)}
          </Link>
          <p className="text-sm font-bold text-text-primary">{slug ? t("common", K.title, { slug }) : t("common", K.titlePlain)}</p>
          <p className="mt-1 text-xs text-text-secondary">{t("common", K.subtitle)}</p>
        </div>
      ),
    }),
    // `t` is stable for a language; the chrome is rebuilt when the name arrives.
    [id, slug, t],
  );

  return <GatewaysView surface={surface} />;
}
