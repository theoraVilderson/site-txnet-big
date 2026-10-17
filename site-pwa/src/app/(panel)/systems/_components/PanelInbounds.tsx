"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, TriangleAlert, Users } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { billingApi, type PanelInbounds as View } from "@/lib/billing-api";
import { formatInstant } from "../../_lib/datetime";
import { formatList } from "../../_lib/digits";
import { soldBy } from "../_lib/inbound-audience";
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
import { LAYER_KEYS } from "../_lib/member-settings";
import { SYSTEMS_KEYS } from "../_lib/systems";
import { InboundAudience } from "./InboundAudience";
import { BAD, QUIET, useSystemsError } from "./parts";
import { Button, Input, RadioCards } from "../../_components/kit";

const K = SYSTEMS_KEYS.inbounds;

/**
 * One panel's inbounds (F-114-b), fetched when opened: which ones a buyer is
 * placed on, how, and the caps. The list is what `network-service` last read;
 * "read again" asks the panel's next pass to read it (a minute), and the list
 * is fetched again once the admin asks for it. The placement and cap are the
 * panel's defaults, each with the layer in force (F-027-ci). Each inbound
 * says who sells it — every group, or the groups chosen — and opens that
 * choice, the groups' shares and taking a group off it (F-027-eu, ADR-0127).
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
  // The inbound whose sellers are open (F-027-eu); one at a time.
  const [opened, setOpened] = useState<string | null>(null);

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

  // After an audience, share or release write: who sells each inbound changed; the picks being edited did not.
  const reread = () =>
    billingApi.panelInbounds(panelId).then(
      (v) => setView(v),
      (e: unknown) => setError(e),
    );

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
        <Button size="sm" onClick={() => void refresh()} disabled={busy} icon={<RefreshCw size={14} aria-hidden />}>
          {t("common", K.refresh)}
        </Button>
      </div>
      <p className="text-xs leading-5 text-text-secondary">{t("common", K.hint)}</p>

      {nothingPicked(view) && (
        <p className={`flex items-start gap-1 rounded-xl border px-3 py-2 text-xs leading-5 ${BAD}`}>
          <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden />
          {t("common", K.nothingPicked)}
        </p>
      )}

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 flex flex-wrap items-center gap-2 text-xs font-bold text-text-primary">
          {t("common", K.placement.label)}
          <span className={`rounded-lg border px-2 py-0.5 font-normal ${QUIET}`}>
            {t("common", K.from, { layer: t("common", LAYER_KEYS[view.effective.inboundPlacement.layer]) })}
          </span>
        </legend>
        <RadioCards
          ariaLabel={t("common", K.placement.label)}
          columns={1}
          value={form.placement}
          onChange={(p) => setForm({ ...form, placement: p })}
          options={INBOUND_PLACEMENTS.map((p) => ({ value: p, label: t("common", PLACEMENT_KEYS[p].label), description: t("common", PLACEMENT_KEYS[p].hint) }))}
        />
      </fieldset>

      {/* K under hrw (F-027-di): asked only there, so it never reads as a second cap. */}
      {form.placement === "hrw" && (
        <label className="flex max-w-xs flex-col gap-1 text-xs text-text-secondary">
          {t("common", K.perBuyer)}
          <Input dir="ltr" inputMode="numeric" value={form.perBuyer} onChange={(e) => setForm({ ...form, perBuyer: e.target.value })} />
          <span className="leading-5">{t("common", K.perBuyerHint)}</span>
          <span>{t("common", K.from, { layer: t("common", LAYER_KEYS[view.effective.inboundsPerBuyer.layer]) })}</span>
          {errors.perBuyer && <span className="text-error">{t("common", errors.perBuyer)}</span>}
        </label>
      )}

      <label className="flex max-w-xs flex-col gap-1 text-xs text-text-secondary">
        {t("common", K.panelMax)}
        <Input dir="ltr" inputMode="numeric" value={form.panelMax} onChange={(e) => setForm({ ...form, panelMax: e.target.value })} />
        <span className="leading-5">{t("common", K.panelMaxHint)}</span>
        <span>{t("common", K.from, { layer: t("common", LAYER_KEYS[view.effective.maxClients.layer]) })}</span>
        {errors.panelMax && <span className="text-error">{t("common", errors.panelMax)}</span>}
      </label>

      <p className="text-xs leading-5 text-text-secondary">{t("common", K.audienceHint)}</p>
      {view.inbounds.length === 0 ? (
        <p className="text-xs text-text-secondary">{t("common", K.empty)}</p>
      ) : (
        <ul className="divide-y divide-card-border">
          {view.inbounds.map((i) => {
            const note = inboundNote(i);
            const p = form.picks[i.remoteId];
            const canSell = sellable(i) || i.sold;
            const sellers = soldBy(i);
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
                <span className={`rounded-lg border px-2 py-0.5 ${QUIET}`}>
                  {t("common", K.soldBy, { groups: sellers.every ? t("common", K.everyGroup) : formatList(sellers.names, lang) || t("common", K.nobody) })}
                </span>
                <span className="text-text-secondary">{t("common", K.clients, { count: String(i.clients) })}</span>
                <label className="flex items-center gap-1 text-text-secondary">
                  {t("common", K.cap)}
                  <Input
                    dir="ltr"
                    inputMode="numeric"
                    value={p.cap}
                    placeholder={t("common", K.capHint)}
                    onChange={(e) => pick(i.remoteId, { cap: e.target.value })}
                    className="w-24"
                  />
                </label>
                <Button variant="quiet" size="sm" onClick={() => setOpened(opened === i.remoteId ? null : i.remoteId)} icon={<Users size={12} aria-hidden />} aria-expanded={opened === i.remoteId}>
                  {t("common", SYSTEMS_KEYS.audience.open)}
                </Button>
                {errors[capField(i.remoteId)] && <span className="w-full text-error">{t("common", errors[capField(i.remoteId)])}</span>}
                {opened === i.remoteId && (
                  <div className="w-full">
                    <InboundAudience panelId={panelId} view={view} inbound={i} onChanged={() => void reread()} />
                  </div>
                )}
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
        <Button variant="primary" size="sm" onClick={() => void save()} disabled={busy}>
          {t("common", K.save)}
        </Button>
      </div>
    </div>
  );
}
