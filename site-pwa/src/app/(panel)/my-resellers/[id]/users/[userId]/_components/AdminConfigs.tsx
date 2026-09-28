"use client";

import { useState } from "react";
import { Ban, KeyRound, Loader2, Play, Trash2 } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import type { AdminConfigActionOutcome, ResellerUserGrantsApi, UserConfigRow } from "@/lib/billing-api";
import { Alert, input, primaryButton, quietButton } from "../../../../../catalog/_components/catalog-ui";
import {
  CONFIG_STATUS_KEYS,
  DRIFT_VERDICTS,
  REFUSAL_KEYS,
  configName,
  formatBytes,
} from "../../../../../services/_lib/service-configs";
import { USER_KEYS as K, adminActionBody, type OfferedAction } from "../../../../_lib/users";
import { useUserMessage } from "./useUserMessage";

const A = K.actions;

type Refused = Extract<AdminConfigActionOutcome, { ok: false }>;

/**
 * A Grant's configs, with an admin's actions on one or on the ticked ones
 * (F-311-g, `billing/contract.reseller-grants.md`): a new link, disable with a
 * reason, enable, delete. **An outcome per config**, as the owner's list:
 * billing answers 200 with each one's verdict, the refused ones are named by
 * the name they had when pressed, and the list is read again.
 *
 * **An admin's new link is outside the user's allowance**, so no "n left"
 * gates the button — billing does not check it for an admin. A disable asks
 * for its reason first: it is the config's `disabledReason`, the sentence the
 * user reads, and billing refuses a disable without one.
 */
export function AdminConfigs({ api, rows, onActed }: { api: ResellerUserGrantsApi; rows: UserConfigRow[]; onActed: () => void }) {
  const { t, lang } = useLocale();
  const message = useUserMessage();

  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [disabling, setDisabling] = useState<string[] | null>(null);
  const [reason, setReason] = useState("");
  const [done, setDone] = useState<number | null>(null);
  const [refused, setRefused] = useState<{ outcome: Refused; label: string }[]>([]);
  const [actError, setActError] = useState<unknown>(null);

  const selected = rows.filter((r) => picked.has(r.id)).map((r) => r.id);
  const allSelected = rows.length > 0 && selected.length === rows.length;

  async function act(action: OfferedAction, ids: string[], why?: string) {
    const body = adminActionBody(action, ids, why);
    if (busy || !body) return;
    if (action === "retire" && !window.confirm(t("common", A.retireConfirm, { count: ids.length }))) return;
    const labels = new Map(rows.map((r) => [r.id, configName(r)]));
    setBusy(true);
    setActError(null);
    setDone(null);
    setRefused([]);
    try {
      const { results } = await api.configAction(body);
      setDone(results.filter((r) => r.ok).length);
      setRefused(
        results
          .filter((r): r is Refused => !r.ok)
          .map((outcome) => ({ outcome, label: labels.get(outcome.configId) ?? outcome.configId })),
      );
      setDisabling(null);
      setReason("");
      setPicked(new Set());
      onActed();
    } catch (e) {
      // The request itself was refused — the door, the body or the limiter —
      // so no config was touched.
      console.error(e);
      setActError(e);
    } finally {
      setBusy(false);
    }
  }

  const toggle = (id: string) =>
    setPicked((before) => {
      const next = new Set(before);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const bar = "flex flex-wrap items-center gap-1";

  return (
    <section aria-label={t("common", K.services.configsTitle)} className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-bold text-text-primary">{t("common", K.services.configsTitle)}</p>
        {rows.length > 1 && (
          <label className="flex items-center gap-1.5 text-xs text-text-secondary">
            <input type="checkbox" checked={allSelected} onChange={() => setPicked(allSelected ? new Set() : new Set(rows.map((r) => r.id)))} />
            {t("common", A.selected, { count: selected.length })}
          </label>
        )}
      </div>

      {selected.length > 0 && (
        <div className={`${bar} rounded-2xl bg-leaf-bg px-3 py-2`}>
          <ActionButtons busy={busy} onAct={(action) => (action === "disable" ? setDisabling(selected) : void act(action, selected))} />
        </div>
      )}

      {disabling && (
        <form
          className="space-y-2 rounded-2xl border border-card-border bg-bg-inner p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void act("disable", disabling, reason);
          }}
        >
          <label className="block text-xs font-bold text-text-secondary">
            {t("common", A.reason)}
            <input
              className={`${input} mt-1`}
              value={reason}
              maxLength={200}
              placeholder={t("common", A.reasonPlaceholder)}
              onChange={(e) => setReason(e.target.value)}
              autoFocus
            />
          </label>
          <div className="flex gap-2">
            <button type="submit" className={primaryButton} disabled={busy || adminActionBody("disable", disabling, reason) === null}>
              {t("common", A.confirmDisable)}
            </button>
            <button type="button" className={quietButton} onClick={() => setDisabling(null)}>
              {t("common", A.cancel)}
            </button>
          </div>
        </form>
      )}

      <ul className="space-y-2">
        {rows.map((row) => {
          const verdict = DRIFT_VERDICTS[row.driftState];
          const label = configName(row);
          const allocated = formatBytes(row.allocatedCeilingBytes, lang);
          return (
            <li key={row.id} className="rounded-2xl border border-card-border bg-bg-inner p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="flex min-w-0 items-center gap-2">
                  {rows.length > 1 && <input type="checkbox" checked={picked.has(row.id)} onChange={() => toggle(row.id)} aria-label={label} />}
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
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${verdict.className}`} title={t("common", verdict.whyKey)}>
                      {t("common", verdict.labelKey)}
                    </span>
                  )}
                </div>
              </div>
              <p className="mt-1 text-xs text-text-secondary" dir="ltr">
                {row.protocol} · {row.region}
                {allocated ? ` · ${allocated}` : ""}
              </p>
              <div className={`${bar} mt-2`}>
                <ActionButtons
                  busy={busy}
                  status={row.status}
                  onAct={(action) => (action === "disable" ? setDisabling([row.id]) : void act(action, [row.id]))}
                />
              </div>
            </li>
          );
        })}
      </ul>
      <p className="text-[11px] text-text-secondary">{t("common", A.regenerateHint)}</p>

      {busy && (
        <p className="flex items-center gap-2 text-xs text-text-secondary">
          <Loader2 size={12} className="animate-spin" aria-hidden />
        </p>
      )}
      {done !== null && done > 0 && (
        <p role="status" className="text-xs font-bold text-primary">
          {t("common", A.done, { count: done })}
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
      {actError !== null && <Alert>{message(actError)}</Alert>}
    </section>
  );
}

/**
 * The four buttons. On one config, enable shows only on a disabled one and
 * disable only on one that is not; on the ticked ones both show, and billing
 * answers each config for itself.
 */
function ActionButtons({ busy, status, onAct }: { busy: boolean; status?: UserConfigRow["status"]; onAct: (action: OfferedAction) => void }) {
  const { t } = useLocale();
  const disabled = status === "disabled_by_admin" || status === "disabled_by_system";
  const button = "inline-flex items-center gap-1 rounded-xl border border-card-border bg-card-bg px-2.5 py-1.5 text-xs font-bold text-text-primary hover:bg-leaf-bg disabled:opacity-50";
  return (
    <>
      <button type="button" className={button} disabled={busy} onClick={() => onAct("regenerate")}>
        <KeyRound size={12} aria-hidden />
        {t("common", A.regenerate)}
      </button>
      {(status === undefined || !disabled) && (
        <button type="button" className={button} disabled={busy} onClick={() => onAct("disable")}>
          <Ban size={12} aria-hidden />
          {t("common", A.disable)}
        </button>
      )}
      {(status === undefined || disabled) && (
        <button type="button" className={button} disabled={busy} onClick={() => onAct("enable")}>
          <Play size={12} aria-hidden />
          {t("common", A.enable)}
        </button>
      )}
      <button
        type="button"
        className="ms-auto inline-flex items-center gap-1 rounded-xl border border-error-border px-2.5 py-1.5 text-xs font-bold text-error hover:bg-error-bg disabled:opacity-50"
        disabled={busy}
        onClick={() => onAct("retire")}
      >
        <Trash2 size={12} aria-hidden />
        {t("common", A.retire)}
      </button>
    </>
  );
}
