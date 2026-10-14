"use client";

import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { AdminGateway } from "@/lib/billing-api";
import { AudienceSection } from "../../_components/AudienceSection";
import { useGatewayMessage, type GatewaySurface } from "../_lib/surface";

const A = FrontendI18nKeys.common.gateways.audience;

/**
 * Who sees this gateway (F-102-g-e): every user, or only users in at least one
 * of the chosen groups. A user outside them is never shown the gateway, and a
 * start that names it is refused as a gateway that does not exist. The shared
 * audience section (GR-1-x), saved on the gateway's own route.
 */
export function GatewayAudienceSection({
  gateway,
  surface,
  onSaved,
}: {
  gateway: AdminGateway;
  surface: GatewaySurface;
  onSaved: (userGroupIds: string[]) => void;
}) {
  const { t } = useLocale();
  const errorMessage = useGatewayMessage(surface);
  return (
    <AudienceSection
      anchorId="gw-section-audience"
      tenantId={surface.tenantId}
      saved={gateway.userGroupIds ?? []}
      save={async (ids) => (await surface.api.setAudience(gateway.source, gateway.id, ids)).userGroupIds}
      onSaved={onSaved}
      errorMessage={errorMessage}
      text={{ title: t("common", A.title), subtitle: t("common", A.subtitle), save: t("common", A.save), saved: t("common", A.saved) }}
    />
  );
}
