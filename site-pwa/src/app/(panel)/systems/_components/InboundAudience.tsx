"use client";

import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { billingApi, type InboundAudience as Audience, type PanelInbound, type PanelInbounds } from "@/lib/billing-api";
import { audienceFormOf, losing, runningRelease, shareField, validateAudience, type AudienceForm } from "../_lib/inbound-audience";
import { SYSTEMS_KEYS } from "../_lib/systems";
import { InboundRelease } from "./InboundRelease";
import { BAD, QUIET, useSystemsError } from "./parts";
import { Alert, Button, Input, RadioCards } from "../../_components/kit";

const A = SYSTEMS_KEYS.audience;

/**
 * Which groups sell one inbound (F-027-eu, ADR-0127): every group
 * on the panel, or only the groups ticked — each with its users there and,
 * on a listed inbound, its share (billing F-027-ep/eq). A save that would take
 * the inbound from a group with users there is not sent: the release step
 * asks move or empty and runs it as a live job (F-027-es); the listing
 * changes when it ends. A running release is shown on open. `onChanged`
 * re-reads the panel's inbounds after every write and a job's end.
 */
export function InboundAudience({ panelId, view, inbound, onChanged }: { panelId: string; view: PanelInbounds; inbound: PanelInbound; onChanged: () => void }) {
  const { t } = useLocale();
  const message = useSystemsError();
  const [form, setForm] = useState<AudienceForm>(() => audienceFormOf(inbound));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [releasing, setReleasing] = useState(() => runningRelease(inbound) !== null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const lost = losing(form, view, inbound);
  const seller = (groupId: string) => inbound.sellers.find((s) => s.groupId === groupId);

  // Back to the choice, read afresh: a release that ended has changed who sells it.
  const back = () => {
    setReleasing(false);
    setForm(audienceFormOf(inbound));
  };

  if (releasing) {
    return (
      <div className="flex flex-col gap-2">
        <InboundRelease panelId={panelId} remoteId={inbound.remoteId} groups={lost} jobId={runningRelease(inbound)} onEnded={onChanged} />
        <div>
          <Button variant="quiet" size="sm" onClick={back}>
            {t("common", A.back)}
          </Button>
        </div>
      </div>
    );
  }

  const save = async () => {
    // A group losing it with users there: billing would refuse (`inbound_has_configs`); the release is the way on.
    if (lost.length > 0) {
      setReleasing(true);
      return;
    }
    const checked = validateAudience(form, inbound);
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      if (checked.audience) await billingApi.setInboundAudience(panelId, inbound.remoteId, checked.audience);
      for (const s of checked.shares) await billingApi.setListingShare(s.groupId, panelId, inbound.remoteId, s.maxClients);
      setSaved(true);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  const tick = (groupId: string, on: boolean) => setForm({ ...form, groups: on ? [...form.groups, groupId] : form.groups.filter((g) => g !== groupId) });

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-card-border p-3">
      <p className="text-xs font-bold text-text-primary">{t("common", A.title)}</p>
      <RadioCards<Audience>
        ariaLabel={t("common", A.title)}
        columns={1}
        value={form.audience}
        onChange={(audience) => setForm({ ...form, audience })}
        options={[
          { value: "every_group", label: t("common", A.everyGroup), description: t("common", A.everyGroupHint) },
          { value: "listed", label: t("common", A.listed), description: t("common", A.listedHint) },
        ]}
      />
      {view.members.length === 0 ? (
        <p className="text-xs text-text-secondary">{t("common", A.noMembers)}</p>
      ) : (
        <ul className="divide-y divide-card-border">
          {view.members.map((g) => {
            const s = seller(g.id);
            const listedNow = inbound.audience === "listed" && s !== undefined;
            const ticked = form.audience === "every_group" || form.groups.includes(g.id);
            return (
              <li key={g.id} className="flex flex-wrap items-center gap-2 py-2 text-xs">
                <label className="flex min-w-0 flex-1 items-center gap-2">
                  {form.audience === "listed" && <input type="checkbox" checked={ticked} onChange={(e) => tick(g.id, e.target.checked)} className="accent-primary" />}
                  <span className="min-w-0 truncate font-bold text-text-primary" dir="auto">
                    {g.name}
                  </span>
                </label>
                <span className="text-text-secondary">{t("common", A.clients, { count: String(s?.clients ?? 0) })}</span>
                {s?.releaseJobId && <span className={`rounded-lg border px-2 py-0.5 ${QUIET}`}>{t("common", A.releasing)}</span>}
                {listedNow && ticked && (
                  <label className="flex items-center gap-1 text-text-secondary">
                    {t("common", A.share)}
                    <Input
                      dir="ltr"
                      inputMode="numeric"
                      value={form.shares[g.id] ?? ""}
                      placeholder={t("common", SYSTEMS_KEYS.inbounds.capHint)}
                      onChange={(e) => setForm({ ...form, shares: { ...form.shares, [g.id]: e.target.value } })}
                      aria-label={t("common", A.share)}
                      className="w-24"
                    />
                  </label>
                )}
                {errors[shareField(g.id)] && <span className="w-full text-error">{t("common", errors[shareField(g.id)])}</span>}
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-2xs leading-5 text-text-secondary">{t("common", inbound.audience === "listed" ? A.shareHint : A.shareLater)}</p>
      {form.audience === "listed" && form.groups.length === 0 && (
        <p className={`flex items-start gap-1 rounded-xl border px-3 py-2 text-xs leading-5 ${BAD}`}>
          <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden />
          {t("common", A.nobody)}
        </p>
      )}
      {errors.form && <p className="text-xs text-error">{t("common", errors.form)}</p>}
      {error !== null && <Alert tone="error">{message(error)}</Alert>}
      {saved && (
        <p role="status" className="text-xs font-bold text-primary">
          {t("common", A.saved)}
        </p>
      )}
      <div>
        <Button variant="primary" size="sm" onClick={() => void save()} loading={busy}>
          {t("common", A.save)}
        </Button>
      </div>
    </div>
  );
}
