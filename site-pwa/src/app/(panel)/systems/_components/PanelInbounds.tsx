"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { billingApi, type PanelInbounds as View } from "@/lib/billing-api";
import { formatInstant } from "../../_lib/datetime";
import {
  INBOUND_PLACEMENTS,
  PLACEMENT_KEYS,
  capField,
  inboundNote,
  inboundsFormOf,
  nothingPicked,
  sellable,
  validateInbounds,
  type InboundsForm,
} from "../_lib/panel-inbounds";
import { SYSTEMS_KEYS } from "../_lib/systems";
import { BAD, QUIET, useSystemsError } from "./parts";

const K = SYSTEMS_KEYS.inbounds;
const INPUT = "rounded-xl border border-card-border bg-card-bg px-3 py-2 text-sm text-text-primary";
const PRIMARY = "rounded-xl bg-primary px-4 py-2 text-xs font-bold text-text-on-accent disabled:opacity-50";
const SECONDARY = "inline-flex items-center gap-1 rounded-xl border border-card-border px-3 py-2 text-xs font-bold text-text-primary hover:bg-leaf-bg disabled:opacity-50";

/**
 * One panel's inbounds (F-114-b), fetched when opened: which ones a buyer is
 * placed on, how, and the caps. The list is what `network-service` last read;
 * "read again" asks the panel's next pass to read it (a minute), and the list
 * is fetched again once the admin asks for it.
 */
export function PanelInbounds({ panelId }: { panelId: string }) {
  const { lang, t } = useLocale();
  const message = useSystemsError();
  const [view, setView] = useState<View | null>(null);
  const [form, setForm] = useState<InboundsForm | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const show = (v: View) => {
    setView(v);
    setForm(inboundsFormOf(v));
    setErrors({});
  };

  const load = useCallback(() => {
    let live = true;
    billingApi.panelInbounds(panelId).then(
      (v) => live && show(v),
      (e: unknown) => live && setError(e),
    );
    return () => {
      live = false;
    };
  }, [panelId]);

  useEffect(load, [load]);

  if (error && !view) {
    return (
      <p role="alert" className="text-xs font-bold text-error">
        {message(error)}
      </p>
    );
  }
  if (!view || !form) {
    return (
      <p className="flex items-center gap-2 text-xs text-text-secondary">
        <Loader2 size={14} className="animate-spin" aria-hidden />
        {t("common", SYSTEMS_KEYS.loading)}
      </p>
    );
  }

  const save = async () => {
    const checked = validateInbounds(form, view);
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      show(await billingApi.updatePanelInbounds(panelId, checked.body));
      setStatus(K.saved);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      await billingApi.refreshPanelInbounds(panelId);
      setStatus(K.refreshed);
      setView({ ...view, inboundsReadAt: null });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const pick = (remoteId: string, change: Partial<InboundsForm["picks"][string]>) =>
    setForm({ ...form, picks: { ...form.picks, [remoteId]: { ...form.picks[remoteId], ...change } } });

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-card-border bg-bg-inner p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-sm font-bold text-text-primary">{t("common", K.title)}</p>
          <p className="text-xs text-text-secondary">
            {t("common", K.readAt)}:{" "}
            <span dir="ltr">{view.inboundsReadAt ? formatInstant(view.inboundsReadAt, lang) : t("common", K.notRead)}</span>
            <span className="ms-3">{t("common", K.users, { count: String(view.users) })}</span>
          </p>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={busy} className={SECONDARY}>
          <RefreshCw size={14} aria-hidden />
          {t("common", K.refresh)}
        </button>
      </div>
      <p className="text-xs leading-5 text-text-secondary">{t("common", K.hint)}</p>

      {nothingPicked(view) && (
        <p className={`flex items-start gap-1 rounded-xl border px-3 py-2 text-xs leading-5 ${BAD}`}>
          <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden />
          {t("common", K.nothingPicked)}
        </p>
      )}

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-xs font-bold text-text-primary">{t("common", K.placement.label)}</legend>
        {INBOUND_PLACEMENTS.map((p) => (
          <label key={p} className="flex items-start gap-2 text-xs text-text-primary">
            <input
              type="radio"
              name={`placement-${panelId}`}
              checked={form.placement === p}
              onChange={() => setForm({ ...form, placement: p })}
              className="mt-0.5 accent-primary"
            />
            <span className="flex flex-col">
              <span className="font-bold">{t("common", PLACEMENT_KEYS[p].label)}</span>
              <span className="text-text-secondary">{t("common", PLACEMENT_KEYS[p].hint)}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <label className="flex max-w-xs flex-col gap-1 text-xs text-text-secondary">
        {t("common", K.panelMax)}
        <input dir="ltr" inputMode="numeric" value={form.panelMax} onChange={(e) => setForm({ ...form, panelMax: e.target.value })} className={INPUT} />
        <span className="leading-5">{t("common", K.panelMaxHint)}</span>
        {errors.panelMax && <span className="text-error">{t("common", errors.panelMax)}</span>}
      </label>

      {view.inbounds.length === 0 ? (
        <p className="text-xs text-text-secondary">{t("common", K.empty)}</p>
      ) : (
        <ul className="divide-y divide-card-border">
          {view.inbounds.map((i) => {
            const note = inboundNote(i);
            const p = form.picks[i.remoteId];
            const canSell = sellable(i) || i.sold;
            return (
              <li key={i.remoteId} className="flex flex-wrap items-center gap-3 py-2 text-xs">
                <label className="flex min-w-0 flex-1 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={p.sold}
                    disabled={!canSell}
                    onChange={(e) => pick(i.remoteId, { sold: e.target.checked })}
                    aria-label={t("common", K.sold)}
                    className="accent-primary"
                  />
                  <span dir="ltr" className="min-w-0 truncate font-mono text-text-primary">
                    #{i.remoteId} · {i.protocol ?? "?"} · {i.port}
                    {i.tag && ` · ${i.tag}`}
                  </span>
                </label>
                {note && <span className={`rounded-lg border px-2 py-0.5 ${note === K.disabled ? QUIET : BAD}`}>{t("common", note)}</span>}
                <span className="text-text-secondary">{t("common", K.clients, { count: String(i.clients) })}</span>
                <label className="flex items-center gap-1 text-text-secondary">
                  {t("common", K.cap)}
                  <input
                    dir="ltr"
                    inputMode="numeric"
                    value={p.cap}
                    placeholder={t("common", K.capHint)}
                    onChange={(e) => pick(i.remoteId, { cap: e.target.value })}
                    className={`${INPUT} w-24`}
                  />
                </label>
                {errors[capField(i.remoteId)] && <span className="w-full text-error">{t("common", errors[capField(i.remoteId)])}</span>}
              </li>
            );
          })}
        </ul>
      )}

      {errors.form && <p className="text-xs text-error">{t("common", errors.form)}</p>}
      {error !== null && (
        <p role="alert" className="text-xs font-bold text-error">
          {message(error)}
        </p>
      )}
      {status && (
        <p role="status" className="text-xs font-bold text-primary">
          {t("common", status)}
        </p>
      )}
      <div>
        <button type="button" onClick={() => void save()} disabled={busy} className={PRIMARY}>
          {t("common", K.save)}
        </button>
      </div>
    </div>
  );
}
