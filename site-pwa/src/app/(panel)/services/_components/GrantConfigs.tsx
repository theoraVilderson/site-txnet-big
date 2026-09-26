"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, ChevronDown, KeyRound, Loader2, Trash2 } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { ApiError } from "@/lib/api-error";
import {
  billingApi,
  type ConfigAction,
  type ConfigActionOutcome,
  type UserConfigRow,
} from "@/lib/billing-api";
import { formatInstant } from "../../_lib/datetime";
import {
  CONFIG_STATUS_KEYS,
  DRIFT_VERDICTS,
  REFUSAL_KEYS,
  ceilingQueued,
  formatBytes,
} from "../_lib/service-configs";
import { ConfigLines } from "./ConfigLines";
import { UsageBars } from "./UsageBars";

const C = FrontendI18nKeys.common.myServices.configs;

type Refused = Extract<ConfigActionOutcome, { ok: false }>;

/**
 * One Grant's configs on the service page (F-027-ac): each config's ceiling
 * and sync verdict, and the two actions a user may take — a new key and
 * delete — on one config or on the ones ticked.
 *
 * **Every verdict but `synced` is a button that says why.** A config the loop
 * repaired, or gave up on, looks exactly like a working one from the outside;
 * the verdict is how a user (and whoever built drift) sees it.
 *
 * **An action answers per config** (user, 2026-09-23). The list is read again
 * after every action, because a deleted config leaves it and a new key spends
 * one of that config's allowance; the refused ones are named with billing's
 * reason under the list, by the label they had when they were pressed.
 *
 * Read only when opened: a user with ten services opens the one they came for.
 * Opening also draws the Grant's last 30 days (F-307-c), read beside the list,
 * and each config is a card of its link lines — copy, QR, and a `.conf` where
 * the protocol needs a file.
 */
export function GrantConfigs({ grantId }: { grantId: string }) {
  const { t, lang } = useLocale();
  const toMessage = useApiErrorMessage();

  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<UserConfigRow[] | null>(null);
  const [readError, setReadError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);
  // Loading is derived, as in `useGrantsPage`: the read in flight is the one
  // whose key has not landed yet.
  const key = `${grantId}|${asked}`;
  const [loaded, setLoaded] = useState<string | null>(null);
  const isLoading = open && loaded !== key;

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<ConfigAction | null>(null);
  const [why, setWhy] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const [refused, setRefused] = useState<{ outcome: Refused; label: string }[]>([]);
  const [actError, setActError] = useState<{ message: string; ref?: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    billingApi
      .grantConfigs(grantId)
      .then((answer) => {
        if (!alive) return;
        setRows(answer.rows);
        setReadError(null);
        // A ticked config that is gone from the list is not a target any more.
        setSelected((before) => new Set(answer.rows.map((r) => r.id).filter((id) => before.has(id))));
      })
      .catch((e) => {
        if (!alive) return;
        setRows(null);
        setReadError(e);
      })
      .finally(() => {
        if (alive) setLoaded(key);
      });
    return () => {
      alive = false;
    };
  }, [open, grantId, key]);

  const labelOf = useCallback(
    (row: UserConfigRow) => `${row.protocol} · ${row.region}`,
    [],
  );

  async function act(action: ConfigAction, ids: string[]) {
    if (busy || ids.length === 0) return;
    if (action === "retire" && !window.confirm(t("common", C.retireConfirm, { count: ids.length }))) return;
    const labels = new Map((rows ?? []).map((r) => [r.id, labelOf(r)]));
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
      setAsked((n) => n + 1);
    } catch (e) {
      // The request itself was refused — the body or the limiter — so no
      // config was touched and the list on screen is still the list.
      console.error(e);
      setActError({ message: toMessage(e), ref: e instanceof ApiError ? e.ref : undefined });
    } finally {
      setBusy(null);
    }
  }

  const toggle = (id: string) =>
    setSelected((before) => {
      const next = new Set(before);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const all = rows ?? [];
  const allSelected = all.length > 0 && all.every((r) => selected.has(r.id));

  return (
    <div className="mt-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between rounded-2xl border border-card-border px-3 py-2 text-xs font-bold text-text-secondary hover:bg-leaf-bg hover:text-text-primary"
      >
        {t("common", open ? C.hide : C.show)}
        <ChevronDown size={14} className={open ? "rotate-180" : ""} aria-hidden />
      </button>

      {open && (
        <div className="mt-2 space-y-2">
          <UsageBars grantId={grantId} />

          {isLoading && rows === null && (
            <p className="flex items-center gap-2 text-xs text-text-secondary">
              <Loader2 size={12} className="animate-spin" aria-hidden />
              {t("common", C.loading)}
            </p>
          )}

          {readError != null && (
            <div role="alert" className="flex items-start gap-2 rounded-2xl border border-error-border bg-error-bg px-3 py-2 text-xs font-medium text-error">
              <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1">{toMessage(readError)}</span>
              <button type="button" onClick={() => setAsked((n) => n + 1)} className="shrink-0 underline">
                {t("common", FrontendI18nKeys.common.myServices.retry)}
              </button>
            </div>
          )}

          {rows !== null && rows.length === 0 && (
            <p className="text-xs text-text-secondary">{t("common", C.empty)}</p>
          )}

          {rows !== null && rows.length > 0 && (
            <>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <label className="flex items-center gap-1.5 text-text-secondary">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={() => setSelected(allSelected ? new Set() : new Set(all.map((r) => r.id)))}
                  />
                  {t("common", C.selectAll)}
                </label>
                {selected.size > 0 && (
                  <>
                    <span className="text-text-secondary">{t("common", C.selected, { count: selected.size })}</span>
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void act("regenerate", [...selected])}
                      className="rounded-xl border border-card-border px-2.5 py-1 font-bold text-text-primary hover:bg-leaf-bg disabled:opacity-50"
                    >
                      {t("common", C.bulkRegenerate)}
                    </button>
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void act("retire", [...selected])}
                      className="rounded-xl border border-error-border px-2.5 py-1 font-bold text-error hover:bg-error-bg disabled:opacity-50"
                    >
                      {t("common", C.bulkRetire)}
                    </button>
                  </>
                )}
              </div>

              <ul className="space-y-2">
                {rows.map((row) => (
                  <ConfigItem
                    key={row.id}
                    row={row}
                    label={labelOf(row)}
                    lang={lang}
                    checked={selected.has(row.id)}
                    onToggle={() => toggle(row.id)}
                    whyOpen={why === row.id}
                    onWhy={() => setWhy((w) => (w === row.id ? null : row.id))}
                    busy={busy}
                    onAct={(action) => void act(action, [row.id])}
                  />
                ))}
              </ul>
            </>
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
                  <span className="font-mono" dir="ltr">
                    {label}
                  </span>
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
        </div>
      )}
    </div>
  );
}

function ConfigItem({
  row,
  label,
  lang,
  checked,
  onToggle,
  whyOpen,
  onWhy,
  busy,
  onAct,
}: {
  row: UserConfigRow;
  label: string;
  lang: string;
  checked: boolean;
  onToggle: () => void;
  whyOpen: boolean;
  onWhy: () => void;
  busy: ConfigAction | null;
  onAct: (action: ConfigAction) => void;
}) {
  const { t } = useLocale();
  const verdict = DRIFT_VERDICTS[row.driftState];
  const allocated = formatBytes(row.allocatedCeilingBytes, lang);
  const applied = formatBytes(row.appliedCeilingBytes, lang) ?? "0 B";
  const keysLeft = Math.max(0, row.maxRegenerateCount - row.regenerateUsedCount);
  const checkedAt = formatInstant(row.lastReconciledAt, lang);

  const ceiling =
    allocated === null
      ? t("common", C.ceilingNone)
      : ceilingQueued(row)
        ? t("common", C.ceilingQueued, { allocated, applied })
        : t("common", C.ceiling, { allocated });

  const pill = `inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${verdict.className}`;

  return (
    <li className="rounded-2xl border border-card-border bg-bg-inner p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <label className="flex min-w-0 items-center gap-2">
          <input type="checkbox" checked={checked} onChange={onToggle} aria-label={label} />
          <span className="truncate font-mono text-xs text-text-primary" dir="ltr">
            {label}
          </span>
        </label>
        <div className="flex flex-wrap items-center gap-1.5">
          {row.status !== "active" && (
            <span className="rounded-full border border-card-border px-2 py-0.5 text-[10px] text-text-secondary">
              {t("common", CONFIG_STATUS_KEYS[row.status])}
            </span>
          )}
          {verdict.whyKey === null ? (
            <span className={pill}>{t("common", verdict.labelKey)}</span>
          ) : (
            <button type="button" aria-expanded={whyOpen} onClick={onWhy} className={`${pill} underline decoration-dotted`}>
              {t("common", verdict.labelKey)}
            </button>
          )}
        </div>
      </div>

      {whyOpen && verdict.whyKey && (
        <p className="mt-2 rounded-xl border border-card-border bg-card-bg px-3 py-2 text-[11px] text-text-secondary">
          {t("common", verdict.whyKey)}
        </p>
      )}

      <p className="mt-2 text-[11px] text-text-secondary">{ceiling}</p>
      {checkedAt && <p className="text-[11px] text-text-secondary">{t("common", C.checkedAt, { at: checkedAt })}</p>}

      <ConfigLines config={row} />

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy !== null || keysLeft === 0}
          onClick={() => onAct("regenerate")}
          className="flex items-center gap-1 rounded-xl border border-card-border px-2.5 py-1 text-[11px] font-bold text-text-primary hover:bg-leaf-bg disabled:opacity-50"
        >
          <KeyRound size={12} aria-hidden />
          {t("common", C.regenerate)}
        </button>
        <span className="text-[10px] text-text-secondary">
          {t("common", C.regenerateLeft, { left: keysLeft, max: row.maxRegenerateCount })}
        </span>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => onAct("retire")}
          className="ms-auto flex items-center gap-1 rounded-xl border border-error-border px-2.5 py-1 text-[11px] font-bold text-error hover:bg-error-bg disabled:opacity-50"
        >
          <Trash2 size={12} aria-hidden />
          {t("common", C.retire)}
        </button>
      </div>
    </li>
  );
}
