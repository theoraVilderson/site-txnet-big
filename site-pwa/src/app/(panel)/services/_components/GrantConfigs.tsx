"use client";

import { useState } from "react";
import { AlertCircle, KeyRound, Loader2, Trash2 } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { ApiError } from "@/lib/api-error";
import { billingApi, type ConfigAction, type ConfigActionOutcome, type RegenerateTerms, type UserConfigRow } from "@/lib/billing-api";
import type { GrantConfigsState } from "../_hooks/useGrantConfigs";
import {
  CONFIG_STATUS_KEYS,
  DRIFT_VERDICTS,
  REFUSAL_KEYS,
  ceilingQueued,
  configName,
  formatBytes,
  regenerateOffer,
  type RegenerateOffer,
} from "../_lib/service-configs";
import { rateDecimals } from "../../catalog/_lib/catalog-form";
import { currencyDecimals, formatMoney } from "../../_lib/money";

const C = FrontendI18nKeys.common.myServices.configs;

type Refused = Extract<ConfigActionOutcome, { ok: false }>;

/**
 * One Grant's servers under "details" (F-027-ac): each one's share of the
 * traffic, and the two actions a user may take — a new link and delete — on
 * one server or on the ones ticked. How to connect is not here; it is the
 * row's "connect", so nothing on this list is pressed by someone who only
 * wanted a link.
 *
 * **A server that is fine says nothing.** Every verdict but `synced` is a
 * button that says why — a config the loop repaired, or gave up on, looks
 * exactly like a working one from the outside — and `synced` shows no pill:
 * a green "synced" on every row taught users a word and nothing else.
 *
 * **An action answers per server** (user, 2026-09-23). The list is read again
 * after every action, because a deleted one leaves it and a new link spends
 * one of its allowance; the refused ones are named with billing's reason
 * under the list, by the name they had when they were pressed.
 *
 * **Only what is shown is acted on.** `shown` is the row's search over the
 * list (user, 2026-09-26); a config ticked and then hidden by a search is not
 * a target, so "delete selected" never reaches one the user cannot see.
 */
export function GrantConfigs({
  configs,
  shown = configs.rows,
}: {
  configs: GrantConfigsState;
  /** The configs the row's search leaves; the whole list when there is none. */
  shown?: UserConfigRow[] | null;
}) {
  const { t, lang } = useLocale();
  const toMessage = useApiErrorMessage();
  const { rows } = configs;

  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<ConfigAction | null>(null);
  const [why, setWhy] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const [refused, setRefused] = useState<{ outcome: Refused; label: string }[]>([]);
  const [actError, setActError] = useState<{ message: string; ref?: string } | null>(null);

  // A ticked server that is gone from the list, or hidden by the search, is
  // not a target any more. The whole list still names a refusal.
  const every = rows ?? [];
  const all = shown ?? [];
  const selected = new Set(all.map((r) => r.id).filter((id) => picked.has(id)));
  const allSelected = all.length > 0 && all.every((r) => selected.has(r.id));

  async function act(action: ConfigAction, ids: string[]) {
    if (busy || ids.length === 0) return;
    if (action === "retire" && !window.confirm(t("common", C.retireConfirm, { count: ids.length }))) return;
    const labels = new Map(every.map((r) => [r.id, configName(r)]));
    setBusy(action);
    setActError(null);
    setDone(null);
    setRefused([]);
    try {
      const { results } = await billingApi.configAction(action, ids);
      setDone(results.filter((r) => r.ok).length);
      setRefused(
        results
          .filter((r): r is Refused => !r.ok)
          .map((outcome) => ({ outcome, label: labels.get(outcome.configId) ?? outcome.configId })),
      );
      configs.reload();
    } catch (e) {
      // The request itself was refused — the body or the limiter — so no
      // server was touched and the list on screen is still the list.
      console.error(e);
      setActError({ message: toMessage(e), ref: e instanceof ApiError ? e.ref : undefined });
    } finally {
      setBusy(null);
    }
  }

  const toggle = (id: string) =>
    setPicked((before) => {
      const next = new Set(before);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <section aria-label={t("common", C.title)} className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-bold text-text-primary">{t("common", C.title)}</p>
        {every.length > 1 && all.length > 0 && (
          <label className="flex items-center gap-1.5 text-xs text-text-secondary">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={() => setPicked(allSelected ? new Set() : new Set(all.map((r) => r.id)))}
            />
            {t("common", C.selectAll)}
          </label>
        )}
      </div>

      {configs.isLoading && rows === null && (
        <p className="flex items-center gap-2 text-xs text-text-secondary">
          <Loader2 size={12} className="animate-spin" aria-hidden />
          {t("common", C.loading)}
        </p>
      )}

      {configs.readError != null && (
        <div role="alert" className="flex items-start gap-2 rounded-2xl border border-error-border bg-error-bg px-3 py-2 text-xs font-medium text-error">
          <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">{toMessage(configs.readError)}</span>
          <button type="button" onClick={configs.reload} className="shrink-0 underline">
            {t("common", FrontendI18nKeys.common.myServices.retry)}
          </button>
        </div>
      )}

      {rows !== null && rows.length === 0 && <p className="text-xs text-text-secondary">{t("common", C.empty)}</p>}

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-leaf-bg px-3 py-2 text-xs">
          <span className="text-text-secondary">{t("common", C.selected, { count: selected.size })}</span>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void act("regenerate", [...selected])}
            className="rounded-xl border border-card-border bg-card-bg px-3 py-1.5 font-bold text-text-primary disabled:opacity-50"
          >
            {t("common", C.bulkRegenerate)}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void act("retire", [...selected])}
            className="rounded-xl border border-error-border bg-card-bg px-3 py-1.5 font-bold text-error disabled:opacity-50"
          >
            {t("common", C.bulkRetire)}
          </button>
        </div>
      )}

      {all.length > 0 && (
        <ul className="space-y-2">
          {all.map((row) => (
            <ConfigItem
              key={row.id}
              row={row}
              regenerate={configs.regenerate}
              label={configName(row)}
              lang={lang}
              selectable={every.length > 1}
              checked={selected.has(row.id)}
              onToggle={() => toggle(row.id)}
              whyOpen={why === row.id}
              onWhy={() => setWhy((w) => (w === row.id ? null : row.id))}
              busy={busy}
              onAct={(action) => void act(action, [row.id])}
            />
          ))}
        </ul>
      )}

      {busy && (
        <p className="flex items-center gap-2 text-xs text-text-secondary">
          <Loader2 size={12} className="animate-spin" aria-hidden />
          {t("common", C.sending)}
        </p>
      )}

      {done !== null && done > 0 && (
        <p role="status" className="text-xs font-bold text-primary">
          {t("common", C.done, { count: done })}
        </p>
      )}

      {refused.length > 0 && (
        <ul role="alert" className="space-y-1 rounded-2xl border border-error-border bg-error-bg px-3 py-2 text-xs text-error">
          {refused.map(({ outcome, label }) => (
            <li key={outcome.configId}>
              <span dir="ltr">{label}</span>
              {": "}
              {t("common", REFUSAL_KEYS[outcome.reason] ?? REFUSAL_KEYS.failed)}
            </li>
          ))}
        </ul>
      )}

      {actError && (
        <div role="alert" className="rounded-2xl border border-error-border bg-error-bg px-3 py-2 text-xs font-medium text-error">
          {actError.message}
          {actError.ref && (
            <span className="mt-1 block font-mono text-[0.65rem] opacity-70" dir="ltr">
              {actError.ref}
            </span>
          )}
        </div>
      )}
    </section>
  );
}

function ConfigItem({
  row,
  regenerate,
  label,
  lang,
  selectable,
  checked,
  onToggle,
  whyOpen,
  onWhy,
  busy,
  onAct,
}: {
  row: UserConfigRow;
  regenerate: RegenerateTerms | null;
  label: string;
  lang: string;
  selectable: boolean;
  checked: boolean;
  onToggle: () => void;
  whyOpen: boolean;
  onWhy: () => void;
  busy: ConfigAction | null;
  onAct: (action: ConfigAction) => void;
}) {
  const { t } = useLocale();
  const verdict = DRIFT_VERDICTS[row.driftState];
  const offerText = (o: RegenerateOffer) => {
    if (o.kind === "capped") return t("common", C.regenerateLeft, { left: o.left, max: o.max });
    if (o.kind === "free") return t("common", C.regenerateFree, { left: o.left });
    if (o.kind === "none") return t("common", C.regenerateNone);
    const price = formatMoney(o.price, o.currencyCode, { lang, t }, { decimals: rateDecimals(o.price, currencyDecimals(o.currencyCode)) });
    return o.per === 1 ? t("common", C.regenerateCost, { price }) : t("common", C.regenerateCostPer, { price, count: o.per });
  };
  const allocated = formatBytes(row.allocatedCeilingBytes, lang);
  const applied = formatBytes(row.appliedCeilingBytes, lang) ?? "0 B";
  const offer = regenerateOffer(regenerate, row);

  const ceiling =
    allocated === null
      ? t("common", C.ceilingNone)
      : ceilingQueued(row)
        ? t("common", C.ceilingQueued, { allocated, applied })
        : t("common", C.ceiling, { allocated });

  return (
    <li className="rounded-2xl border border-card-border bg-bg-inner p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex min-w-0 items-center gap-2">
          {selectable && <input type="checkbox" checked={checked} onChange={onToggle} aria-label={label} />}
          <span className="truncate text-sm font-bold text-text-primary" dir="ltr">
            {label}
          </span>
        </label>
        <div className="flex flex-wrap items-center gap-1.5">
          {row.status !== "active" && (
            <span className="rounded-full border border-card-border px-2 py-0.5 text-xs text-text-secondary">
              {t("common", CONFIG_STATUS_KEYS[row.status])}
            </span>
          )}
          {verdict.whyKey !== null && (
            <button
              type="button"
              aria-expanded={whyOpen}
              onClick={onWhy}
              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium underline decoration-dotted ${verdict.className}`}
            >
              {t("common", verdict.labelKey)}
            </button>
          )}
        </div>
      </div>

      {whyOpen && verdict.whyKey && (
        <p className="mt-2 rounded-xl border border-card-border bg-card-bg px-3 py-2 text-xs leading-6 text-text-secondary">
          {t("common", verdict.whyKey)}
        </p>
      )}

      <p className="mt-2 text-xs text-text-secondary">{ceiling}</p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy !== null || offer.disabled}
          onClick={() => onAct("regenerate")}
          className="flex items-center gap-1.5 rounded-xl border border-card-border px-3 py-1.5 text-xs font-bold text-text-primary hover:bg-leaf-bg disabled:opacity-50"
        >
          <KeyRound size={14} aria-hidden />
          {t("common", C.regenerate)}
        </button>
        <span className="text-xs text-text-secondary">{offerText(offer)}</span>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => onAct("retire")}
          className="ms-auto flex items-center gap-1.5 rounded-xl border border-error-border px-3 py-1.5 text-xs font-bold text-error hover:bg-error-bg disabled:opacity-50"
        >
          <Trash2 size={14} aria-hidden />
          {t("common", C.retire)}
        </button>
      </div>
    </li>
  );
}
