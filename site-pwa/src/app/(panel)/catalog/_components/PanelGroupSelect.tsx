"use client";

import { useEffect, useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import type { PanelGroupOption } from "@/lib/catalog-api";
import { useCatalogSurface } from "../_lib/surface";
import { Select } from "../../_components/kit/Select";
import { CATALOG_KEYS as K } from "../_lib/catalog-form";
import { Field } from "./catalog-ui";

/** The groups a variant may name on this surface, and whether they loaded. */
export interface PanelGroups {
  options: PanelGroupOption[];
  failed: boolean;
}

/** `GET /panel-groups` once, when the product is `network_access` (F-026-p); a failure costs the choices, never the form. */
export function usePanelGroups(enabled: boolean): PanelGroups {
  const { api } = useCatalogSurface();
  const [state, setState] = useState<PanelGroups>({ options: [], failed: false });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    api.panelGroups().then(
      (options) => live && setState({ options, failed: false }),
      () => live && setState({ options: [], failed: true }),
    );
    return () => {
      live = false;
    };
  }, [enabled, api]);
  return state;
}

/**
 * A variant's panel group (F-026-o): "none" first, because none is a real
 * answer — the variant is kept and simply not sold. Each group says whose it
 * is, how many panels fulfilment would place on now, and whether its strategy
 * is fulfilled at all. A group the list no longer has keeps its id as a label,
 * so the select never shows a variant as having none when it has one.
 */
export function PanelGroupSelect({ value, groups, onChange }: { value: string; groups: PanelGroups; onChange: (id: string) => void }) {
  const { t } = useLocale();
  const label = (g: PanelGroupOption) =>
    [
      g.name,
      g.tenantId === null ? t("common", K.platform) : null,
      g.protocols.length > 0 ? g.protocols.join("/") : t("common", K.variant.noInbound),
      t("common", K.variant.healthy, { count: g.healthyMembers }),
      g.strategy === "mirror" ? null : t("common", K.variant.notFulfilled),
    ]
      .filter(Boolean)
      .join(" · ");
  const options = [{ value: "", label: t("common", K.variant.panelGroupNone) }, ...groups.options.map((g) => ({ value: g.id, label: label(g) }))];
  if (value && !groups.options.some((g) => g.id === value)) options.push({ value, label: value });
  return (
    <Field label={t("common", K.variant.panelGroup)} hint={t("common", groups.failed ? K.variant.panelGroupsFailed : K.variant.panelGroupHint)}>
      <Select ariaLabel={t("common", K.variant.panelGroup)} value={value} onChange={onChange} options={options} />
    </Field>
  );
}
