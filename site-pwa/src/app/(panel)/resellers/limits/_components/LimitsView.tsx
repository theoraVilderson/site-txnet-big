"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Gauge, RotateCw } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { resellerLimitsApi, tenantApi, type Reseller, type ResellerLimitKey, type ResellerLimitRow, type TenantPackage } from "@/lib/tenant-api";
import { PANEL_RESELLERS } from "@/lib/routes";
import { usePanelSession } from "../../../_context/PanelSessionContext";
import { TableSkeleton } from "../../../_components/kit/TableSkeleton";
import { Alert, primaryButton, quietButton, useMessage } from "../../_components/resellers-ui";
import { RESELLER_KEYS, canAdministerResellers } from "../../_lib/resellers";
import { LIMIT_KEYS as K, limitValueOf } from "../../_lib/limits";
import { PackageProducts } from "./PackageProducts";
import { QuotaOverage } from "./QuotaOverage";

const input = "w-28 rounded-xl border border-card-border bg-bg-inner px-3 py-2 text-sm text-text-primary outline-none focus:border-primary";

/**
 * What a reseller may spend of the platform's (F-019-r, ADR-0106,
 * `tenant/contract.limits.md`): per key, the platform's value, each package's,
 * and the resellers holding one of their own — and setting it for one or
 * several resellers at once, with a reason. A quota key also says what happens
 * past it, per level, and each package's platform products and their sales
 * quotas are set below the keys (F-019-v9, ADR-0107 points 2, 3).
 *
 * Every number shown is tenant-service's answer, read again after each save;
 * nothing here decides which level wins. Who may see it is tenant-service's to
 * decide; the check here only spares a reseller who typed the path.
 */
export function LimitsView() {
  const { t } = useLocale();
  const { me, isLoading: sessionLoading } = usePanelSession();
  const message = useMessage();
  const allowed = canAdministerResellers(me);

  const [rows, setRows] = useState<ResellerLimitRow[] | null>(null);
  const [packages, setPackages] = useState<TenantPackage[]>([]);
  const [resellers, setResellers] = useState<Reseller[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);
  const reload = useCallback(() => setAsked((n) => n + 1), []);

  useEffect(() => {
    if (!allowed) return;
    let alive = true;
    Promise.all([resellerLimitsApi.table(), tenantApi.packages(), tenantApi.resellers(100, 0)]).then(
      ([table, pkgs, list]) => {
        if (!alive) return;
        setRows(table);
        setPackages(pkgs);
        setResellers(list);
        setError(null);
      },
      (e) => alive && setError(e),
    );
    return () => {
      alive = false;
    };
  }, [allowed, asked]);

  if (sessionLoading) return null;
  if (!allowed) {
    return (
      <div className="mx-auto w-full max-w-7xl p-4 md:p-8">
        <Alert>{t("common", RESELLER_KEYS.refusals.not_platform_owner)}</Alert>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-4 md:p-8">
      <header>
        <Link href={PANEL_RESELLERS} className="mb-2 inline-flex items-center gap-1 text-xs font-bold text-primary hover:underline">
          <ArrowLeft size={14} aria-hidden />
          {t("common", K.back)}
        </Link>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary md:text-3xl">
          <Gauge size={22} className="text-primary" aria-hidden />
          {t("common", K.title)}
        </h1>
        <p className="mt-1 text-sm text-text-secondary">{t("common", K.subtitle)}</p>
      </header>

      {error !== null ? (
        <div className="flex flex-wrap items-center gap-3">
          <Alert>{message(error)}</Alert>
          <button type="button" className={quietButton} onClick={reload}>
            <RotateCw size={12} aria-hidden />
            {t("common", RESELLER_KEYS.retry)}
          </button>
        </div>
      ) : rows === null ? (
        <TableSkeleton rows={4} columns={3} />
      ) : (
        rows.map((row) => <LimitCard key={row.key} row={row} packages={packages} resellers={resellers} onSaved={reload} />)
      )}

      {error === null && rows !== null && packages.length > 0 && <PackageProducts packages={packages} />}
    </div>
  );
}

/** What a level holds, in words: a number, no limit, or not set (the next level applies). */
function useHeld() {
  const { t } = useLocale();
  return (value: number | null | undefined) =>
    value === undefined ? t("common", K.notSet) : value === null ? t("common", K.noLimit) : String(value);
}

function LimitCard({ row, packages, resellers, onSaved }: { row: ResellerLimitRow; packages: TenantPackage[]; resellers: Reseller[]; onSaved: () => void }) {
  const { t } = useLocale();
  const message = useMessage();
  const held = useHeld();
  const name = (K.keys as Record<ResellerLimitKey, { name: string; hint: string }>)[row.key];
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const run = async (work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    setNotice(null);
    try {
      await work();
      setNotice(t("common", K.saved));
      onSaved();
    } catch (e) {
      setFailure(message(e));
    } finally {
      setBusy(false);
    }
  };

  const own = new Map(row.packages.map((p) => [p.packageId, p.value]));

  return (
    <section aria-label={t("common", name.name)} className="space-y-4 rounded-2xl border border-card-border bg-card-bg p-4">
      <div>
        <h2 className="text-base font-bold text-text-primary">{t("common", name.name)}</h2>
        <p className="mt-1 text-xs leading-5 text-text-secondary">{t("common", name.hint)}</p>
        <p className="mt-1 text-xs text-text-secondary">
          {t("common", K.codeDefault, { count: row.codeDefault === null ? t("common", K.noLimit) : row.codeDefault })} · {t("common", K.max, { count: row.max })}
        </p>
      </div>

      <div className="space-y-2">
        <h3 className="text-xs font-bold text-text-primary">{t("common", K.platform)}</h3>
        <p className="text-xs text-text-secondary">{t("common", K.current, { value: held(row.platform?.value) })}</p>
        <ValueEditor
          label={t("common", K.platform)}
          max={row.max}
          busy={busy}
          onSave={(v) => run(() => resellerLimitsApi.setPlatform(row.key, v))}
          onClear={row.platform ? () => run(() => resellerLimitsApi.clearPlatform(row.key)) : undefined}
        />
      </div>

      {packages.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-bold text-text-primary">{t("common", K.perPackage)}</h3>
          {packages.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center gap-2 border-t border-card-border pt-2">
              <span className="min-w-32 text-sm font-bold text-text-primary">{p.name}</span>
              <span className="text-xs text-text-secondary">{t("common", K.current, { value: held(own.has(p.id) ? own.get(p.id) : undefined) })}</span>
              <ValueEditor
                label={p.name}
                max={row.max}
                busy={busy}
                onSave={(v) => run(() => resellerLimitsApi.setPackage(p.id, row.key, v))}
                onClear={own.has(p.id) ? () => run(() => resellerLimitsApi.clearPackage(p.id, row.key)) : undefined}
              />
            </div>
          ))}
        </div>
      )}

      {row.resellers.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-bold text-text-primary">{t("common", K.ownValues)}</h3>
          <ul className="space-y-1">
            {row.resellers.map((r) => (
              <li key={r.tenantId} className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-bold text-text-primary" dir="ltr">
                  {r.slug}
                </span>
                <span className="text-text-secondary">{held(r.value)}</span>
                <span className="text-text-secondary">— {r.reason}</span>
                <button type="button" className={quietButton} disabled={busy} onClick={() => run(() => resellerLimitsApi.clearResellers(row.key, [r.tenantId]))}>
                  {t("common", K.remove, { slug: r.slug })}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <ForResellers row={row} resellers={resellers} busy={busy} onApply={(ids, v, reason) => run(() => resellerLimitsApi.setResellers(row.key, ids, v, reason))} />

      <QuotaOverage row={row} packages={packages} busy={busy} run={run} />

      {notice && <p className="text-xs font-bold text-primary">{notice}</p>}
      {failure && <Alert>{failure}</Alert>}
    </section>
  );
}

/** A number or "no limit", and a save; "back" only when this level has a row. */
function ValueEditor({
  label,
  max,
  busy,
  onSave,
  onClear,
}: {
  label: string;
  max: number;
  busy: boolean;
  onSave: (value: number | null) => void;
  onClear?: () => void;
}) {
  const { t } = useLocale();
  const [typed, setTyped] = useState("");
  const [noLimit, setNoLimit] = useState(false);
  const value = limitValueOf(typed, noLimit, max);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        type="text"
        inputMode="numeric"
        dir="ltr"
        aria-label={t("common", K.valueFor, { name: label })}
        value={typed}
        disabled={noLimit}
        onChange={(e) => setTyped(e.target.value)}
        className={input}
      />
      <label className="flex items-center gap-1 text-xs text-text-secondary">
        <input type="checkbox" checked={noLimit} onChange={(e) => setNoLimit(e.target.checked)} />
        {t("common", K.noLimit)}
      </label>
      <button type="button" className={primaryButton} disabled={busy || value === undefined} onClick={() => value !== undefined && onSave(value)}>
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

/** One request for one or several resellers: who, the value, and why. */
function ForResellers({
  row,
  resellers,
  busy,
  onApply,
}: {
  row: ResellerLimitRow;
  resellers: Reseller[];
  busy: boolean;
  onApply: (ids: string[], value: number | null, reason: string) => void;
}) {
  const { t } = useLocale();
  const [picked, setPicked] = useState<string[]>([]);
  const [typed, setTyped] = useState("");
  const [noLimit, setNoLimit] = useState(false);
  const [reason, setReason] = useState("");
  const value = limitValueOf(typed, noLimit, row.max);
  const ready = picked.length > 0 && value !== undefined && reason.trim().length > 0 && !busy;
  const toggle = (id: string) => setPicked((now) => (now.includes(id) ? now.filter((x) => x !== id) : [...now, id]));

  if (resellers.length === 0) return null;
  return (
    <fieldset className="space-y-2 rounded-xl border border-card-border p-3">
      <legend className="px-1 text-xs font-bold text-text-primary">{t("common", K.forResellers)}</legend>
      <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto">
        {resellers.map((r) => (
          <label key={r.id} className="flex items-center gap-1 rounded-lg border border-card-border px-2 py-1 text-xs">
            <input type="checkbox" checked={picked.includes(r.id)} onChange={() => toggle(r.id)} />
            <span dir="ltr">{r.slug}</span>
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          inputMode="numeric"
          dir="ltr"
          aria-label={t("common", K.valueFor, { name: t("common", K.forResellers) })}
          value={typed}
          disabled={noLimit}
          onChange={(e) => setTyped(e.target.value)}
          className={input}
        />
        <label className="flex items-center gap-1 text-xs text-text-secondary">
          <input type="checkbox" checked={noLimit} onChange={(e) => setNoLimit(e.target.checked)} />
          {t("common", K.noLimit)}
        </label>
        <input
          type="text"
          maxLength={500}
          aria-label={t("common", K.reason)}
          placeholder={t("common", K.reason)}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className={`${input} w-56 flex-1`}
        />
        <button
          type="button"
          className={primaryButton}
          disabled={!ready}
          onClick={() => value !== undefined && onApply(picked, value, reason.trim())}
        >
          {t("common", K.apply, { count: picked.length })}
        </button>
      </div>
    </fieldset>
  );
}
