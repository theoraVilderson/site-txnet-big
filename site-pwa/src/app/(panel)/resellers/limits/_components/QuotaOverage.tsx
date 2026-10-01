"use client";

import { useId, useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { resellerLimitsApi, type OverageView, type QuotaOverageMode, type ResellerLimitRow, type TenantPackage } from "@/lib/tenant-api";
import { primaryButton, quietButton } from "../../_components/resellers-ui";
import { LIMIT_KEYS as K, overageBodyOf } from "../../_lib/limits";

const input = "w-28 rounded-xl border border-card-border bg-bg-inner px-3 py-2 text-sm text-text-primary outline-none focus:border-primary";

/** What a level holds past a quota, in words: not set (the next level applies), refuse, or a price per extra unit. */
export function useOverageHeld() {
  const { t } = useLocale();
  return (o: OverageView | undefined) =>
    o === undefined
      ? t("common", K.notSet)
      : o.mode === "stop"
        ? t("common", K.overage.stopped)
        : t("common", K.overage.priced, { price: o.unitPrice ?? "", currency: o.currencyCode ?? "" });
}

/**
 * Past a quota's included amount (F-019-v9, ADR-0107 point 2): the platform's
 * answer and each package's — refuse, or sell each extra unit at a price in
 * the platform's currency — and a reseller's own, removed alone. Shown only for
 * a `quota` key; a guard is never sold past. The levels resolve at
 * tenant-service, as the number does; nothing here picks a winner.
 */
export function QuotaOverage({
  row,
  packages,
  busy,
  run,
}: {
  row: ResellerLimitRow;
  packages: TenantPackage[];
  busy: boolean;
  run: (work: () => Promise<unknown>) => void;
}) {
  const { t } = useLocale();
  const held = useOverageHeld();
  if (row.kind !== "quota" || row.overage === null) return null;
  const { overage } = row;
  const own = new Map(overage.packages.map((p) => [p.packageId, p]));
  const platform = t("common", K.platform);

  return (
    <div className="space-y-2 rounded-xl border border-card-border p-3">
      <h3 className="text-xs font-bold text-text-primary">{t("common", K.overage.title)}</h3>
      <p className="text-xs leading-5 text-text-secondary">{t("common", K.overage.hint)}</p>

      <div className="space-y-1">
        <span className="text-xs font-bold text-text-primary">{platform}</span>
        <p className="text-xs text-text-secondary">{t("common", K.current, { value: held(overage.platform ?? undefined) })}</p>
        <OverageEditor
          label={platform}
          busy={busy}
          onSave={(body) => run(() => resellerLimitsApi.setPlatformOverage(row.key, body))}
          onClear={overage.platform ? () => run(() => resellerLimitsApi.clearPlatformOverage(row.key)) : undefined}
        />
      </div>

      {packages.map((p) => (
        <div key={p.id} className="space-y-1 border-t border-card-border pt-2">
          <span className="text-sm font-bold text-text-primary">{p.name}</span>
          <p className="text-xs text-text-secondary">{t("common", K.current, { value: held(own.get(p.id)) })}</p>
          <OverageEditor
            label={p.name}
            busy={busy}
            onSave={(body) => run(() => resellerLimitsApi.setPackageOverage(p.id, row.key, body))}
            onClear={own.has(p.id) ? () => run(() => resellerLimitsApi.clearPackageOverage(p.id, row.key)) : undefined}
          />
        </div>
      ))}

      {overage.resellers.length > 0 && (
        <ul className="space-y-1 border-t border-card-border pt-2">
          {overage.resellers.map((r) => (
            <li key={r.tenantId} className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-bold text-text-primary" dir="ltr">
                {r.slug}
              </span>
              <span className="text-text-secondary">{held(r)}</span>
              <span className="text-text-secondary">— {r.reason}</span>
              <button type="button" className={quietButton} disabled={busy} onClick={() => run(() => resellerLimitsApi.clearResellersOverage(row.key, [r.tenantId]))}>
                {t("common", K.overage.remove, { slug: r.slug })}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Refuse, or sell at a price; save waits for a valid one. "Back" only where the level has a row. */
export function OverageEditor({
  label,
  busy,
  onSave,
  onClear,
}: {
  label: string;
  busy: boolean;
  onSave: (body: NonNullable<ReturnType<typeof overageBodyOf>>) => void;
  onClear?: () => void;
}) {
  const { t } = useLocale();
  const name = useId();
  const [mode, setMode] = useState<QuotaOverageMode>("stop");
  const [price, setPrice] = useState("");
  const body = overageBodyOf(mode, price);
  return (
    <div role="group" aria-label={t("common", K.overage.for, { name: label })} className="flex flex-wrap items-center gap-2">
      <ModeRadios name={name} mode={mode} onChange={setMode} />
      <input
        type="text"
        inputMode="decimal"
        dir="ltr"
        aria-label={t("common", K.overage.priceFor, { name: label })}
        value={price}
        disabled={mode === "stop"}
        onChange={(e) => setPrice(e.target.value)}
        className={input}
      />
      <button type="button" className={primaryButton} disabled={busy || body === undefined} onClick={() => body && onSave(body)}>
        {t("common", K.save)}
      </button>
      {onClear && (
        <button type="button" className={quietButton} disabled={busy} onClick={onClear}>
          {t("common", K.clear)}
        </button>
      )}
    </div>
  );
}

export function ModeRadios({ name, mode, onChange }: { name: string; mode: QuotaOverageMode; onChange: (m: QuotaOverageMode) => void }) {
  const { t } = useLocale();
  return (
    <>
      <label className="flex items-center gap-1 text-xs text-text-secondary">
        <input type="radio" name={name} checked={mode === "stop"} onChange={() => onChange("stop")} />
        {t("common", K.overage.refuse)}
      </label>
      <label className="flex items-center gap-1 text-xs text-text-secondary">
        <input type="radio" name={name} checked={mode === "overage"} onChange={() => onChange("overage")} />
        {t("common", K.overage.sell)}
      </label>
    </>
  );
}
