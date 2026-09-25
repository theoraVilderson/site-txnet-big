"use client";

import { Pencil, Trash2 } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import type { CatalogCapability } from "@/lib/catalog-api";
import { CATALOG_KEYS as K, canEditCapability } from "../_lib/catalog-form";
import { quietButton } from "./catalog-ui";

const C = K.capabilities;

/**
 * The capabilities tab (F-114-f-b, ADR-0086): what a product can unlock, by
 * name. The platform owner edits every row; a tenant — or a reseller's screen —
 * its own, and sees the platform's as read-only. A removal billing refuses
 * (`capability_in_use`) comes back through `onRemove`'s error, like any action.
 */
export function CapabilitiesTab({
  capabilities,
  owner,
  label,
  onRename,
  onRemove,
}: {
  capabilities: readonly CatalogCapability[];
  owner: boolean;
  label: (c: CatalogCapability) => string;
  onRename: (c: CatalogCapability) => void;
  onRemove: (c: CatalogCapability) => void;
}) {
  const { t } = useLocale();
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11px] text-text-secondary">{t("common", C.listHint)}</p>
      {capabilities.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-card-border p-6 text-center text-xs text-text-secondary">{t("common", C.empty)}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {capabilities.map((c) => {
            const editable = canEditCapability(c, owner);
            return (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-card-border bg-card-bg p-3 shadow-sm">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold text-text-primary">{label(c)}</p>
                  <p className="text-[11px] text-text-secondary">
                    <span dir="ltr" className="font-mono">
                      {c.key}
                    </span>
                    {c.tenantId === null && ` · ${t("common", K.platform)}`}
                  </p>
                </div>
                {editable ? (
                  <div className="flex gap-1">
                    <button type="button" className={quietButton} onClick={() => onRename(c)}>
                      <Pencil size={14} aria-hidden />
                      {t("common", K.rename)}
                    </button>
                    <button
                      type="button"
                      className={quietButton}
                      onClick={() => {
                        if (window.confirm(t("common", C.confirmRemove, { name: label(c) }))) onRemove(c);
                      }}
                    >
                      <Trash2 size={14} aria-hidden />
                      {t("common", C.removeOne)}
                    </button>
                  </div>
                ) : (
                  <span className="text-[11px] text-text-secondary">{t("common", C.platformOnly)}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
