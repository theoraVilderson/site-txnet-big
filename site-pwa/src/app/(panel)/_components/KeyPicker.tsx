"use client";

import { useMemo } from "react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { PermissionArea } from "@/lib/auth-api";
import { editorAreas, permissionIndex, unknownKeys } from "../my-resellers/_lib/roles";
import { Badge, Checkbox } from "./kit";

const K = FrontendI18nKeys.common.tenantRoles;

/**
 * Tick permission keys, by area, labelled from the registry (F-1201-d, AC-1-f):
 * a role's keys on the Roles page, a group's extra keys on its Access sheet
 * (AC-1-o). It offers what `grantable` holds (`*` = every key, ADR-0134) plus
 * what `held` already has; a held key the caller may not grant is shown
 * locked, and one the registry does not name is shown raw — never dropped.
 */
export function KeyPicker({
  registry,
  grantable,
  held,
  value,
  onChange,
  label,
}: {
  registry: readonly PermissionArea[];
  grantable: readonly string[];
  /** What the role or group holds as saved: kept visible whatever the caller may grant. */
  held: readonly string[];
  value: readonly string[];
  onChange: (keys: string[]) => void;
  label?: string;
}) {
  const { t } = useLocale();
  const index = useMemo(() => permissionIndex(registry), [registry]);
  const areas = editorAreas(registry, grantable, held);
  const strays = unknownKeys(held, index);
  const toggle = (key: string, on: boolean) => onChange(on ? [...value, key] : value.filter((k) => k !== key));

  return (
    <div className="space-y-3">
      <p className="text-sm font-bold text-text-primary">{label ?? t("common", K.permissions)}</p>
      <p className="text-xs text-text-secondary">{t("common", areas.length === 0 ? K.noneGrantable : K.onlyYours)}</p>
      {areas.map((area) => (
        <fieldset key={area.area} className="space-y-2 rounded-xl border border-card-border p-3">
          <legend className="px-1 text-xs font-bold text-text-secondary">{area.label}</legend>
          {area.permissions.map((p) => (
            <div key={p.key} className="flex items-start justify-between gap-2">
              <Checkbox
                checked={value.includes(p.key)}
                disabled={p.locked}
                onChange={(on) => toggle(p.key, on)}
                label={p.label}
                hint={p.description || undefined}
              />
              {p.platformOnly && <Badge tone="neutral">{t("common", K.platformOnly)}</Badge>}
            </div>
          ))}
        </fieldset>
      ))}
      {strays.length > 0 && (
        <fieldset className="space-y-2 rounded-xl border border-card-border p-3">
          <legend className="px-1 text-xs font-bold text-text-secondary">{t("common", K.other)}</legend>
          {strays.map((key) => (
            <Checkbox key={key} checked={value.includes(key)} disabled onChange={() => undefined} label={<span dir="ltr">{key}</span>} />
          ))}
        </fieldset>
      )}
    </div>
  );
}
