"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2, TriangleAlert } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { billingApi, type PanelGroup, type PanelGroupMember, type PanelInbounds } from "@/lib/billing-api";
import { Sheet } from "../../catalog/_components/catalog-ui";
import { INBOUND_PLACEMENTS, PLACEMENT_KEYS } from "../_lib/panel-inbounds";
import { inboundChoices, memberChoiceOf, perBuyerAsked, sellsNobody, validateMemberChoice, type MemberChoice, type MemberChoiceErrors } from "../_lib/member-settings";
import { SYSTEMS_KEYS } from "../_lib/systems";
import { BAD, Pill, QUIET, useSystemsError } from "./parts";
import { Alert, Button, Input, RadioCards } from "../../_components/kit";

const K = SYSTEMS_KEYS.groups;

/** "Same as the panel" or this group's own, said as a choice (F-027-ck), with what "the panel" means right now. `name` is the setting's name, the group's label. */
function Choice({ name, value, onChange, same, own, children }: { name: string; value: "panel" | "own"; onChange: (v: "panel" | "own") => void; same: string; own: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <RadioCards<"panel" | "own">
        ariaLabel={name}
        columns={1}
        value={value}
        onChange={onChange}
        options={(["panel", "own"] as const).map((v) => ({ value: v, label: v === "panel" ? same : own }))}
      />
      {value === "own" && children && <div className="flex flex-col gap-2 ps-6">{children}</div>}
    </div>
  );
}

/**
 * How this group sells on this member's panel (F-027-ci, rule 16), in one
 * sheet with one save (F-027-ck). Each setting is a choice — the panel's,
 * read from its inbounds view with the value in force, or this group's own —
 * so nothing hides behind an empty field. The two writes (settings, then
 * inbounds) run only when changed; a refusal re-reads, since another group
 * may have taken an inbound meanwhile.
 */
export function MemberSheet({
  group,
  member,
  onClose,
  onSaved,
  onChanged,
}: {
  group: PanelGroup;
  member: PanelGroupMember;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onChanged: () => Promise<void>;
}) {
  const { lang, t } = useLocale();
  const message = useSystemsError();
  const M = SYSTEMS_KEYS.member;
  const [view, setView] = useState<PanelInbounds | null>(null);
  const [form, setForm] = useState<MemberChoice | null>(null);
  const [errors, setErrors] = useState<MemberChoiceErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Read once per panel: the parent's re-read hands a new `member` object, which must not refetch the inbounds.
  const latest = useRef({ member, message });
  useEffect(() => {
    latest.current = { member, message };
  });

  useEffect(() => {
    let live = true;
    billingApi.panelInbounds(member.panelId).then(
      (v) => {
        if (!live) return;
        setView(v);
        setForm((f) => f ?? memberChoiceOf(latest.current.member, v));
      },
      (e: unknown) => live && setFailure(latest.current.message(e)),
    );
    return () => {
      live = false;
    };
  }, [member.panelId]);

  const save = async () => {
    if (!form) return;
    const checked = validateMemberChoice(form, member);
    if (!checked.ok) return setErrors(checked.errors);
    setErrors({});
    setFailure(null);
    setBusy(true);
    try {
      if (checked.settings) await billingApi.updatePanelGroupMember(group.id, member.panelId, checked.settings);
      if (checked.inbounds) await billingApi.setPanelGroupMemberInbounds(group.id, member.panelId, checked.inbounds);
      await onSaved();
    } catch (e) {
      setFailure(message(e));
      await Promise.all([onChanged(), billingApi.panelInbounds(member.panelId).then(setView, () => undefined)]);
    } finally {
      setBusy(false);
    }
  };

  const set = (change: Partial<MemberChoice>) => setForm((f) => (f ? { ...f, ...change } : f));
  const panelPlacement = view && t("common", PLACEMENT_KEYS[view.effective.inboundPlacement.value].label);
  const panelCap = view && (view.effective.maxClients.value === null ? t("common", M.noCap) : String(view.effective.maxClients.value));
  const panelPerBuyer = view && String(view.effective.inboundsPerBuyer.value);
  // What the form would sell right now, so the warning follows the ticks, not the saved row.
  const preview = form && { ...member, inbounds: form.inboundsMode === "pool" ? [] : form.picked };

  return (
    <Sheet
      title={t("common", M.title, { group: group.name, panel: member.panelName })}
      onClose={onClose}
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="quiet" size="sm" onClick={onClose}>
            {t("common", K.cancel)}
          </Button>
          <Button variant="primary" size="sm" disabled={busy || !form} onClick={() => void save()}>
            {t("common", M.save)}
          </Button>
        </div>
      }
    >
      <p className="text-xs leading-5 text-text-secondary">{t("common", M.intro)}</p>
      {!view || !form ? (
        failure ? (
          <Alert tone="error">{failure}</Alert>
        ) : (
          <p className="flex items-center gap-2 text-xs text-text-secondary">
            <Loader2 size={14} className="animate-spin" aria-hidden />
            {t("common", K.settings.loading)}
          </p>
        )
      ) : (
        <>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-xs font-bold text-text-primary">{t("common", M.placement)}</legend>
            <Choice
              name={t("common", M.placement)}
              value={form.placementMode}
              onChange={(v) => set({ placementMode: v })}
              same={t("common", M.samePanelValue, { value: panelPlacement ?? "" })}
              own={t("common", M.own)}
            >
              <RadioCards
                ariaLabel={t("common", M.placement)}
                columns={1}
                value={form.placement}
                onChange={(p) => set({ placement: p })}
                options={INBOUND_PLACEMENTS.map((p) => ({ value: p, label: t("common", PLACEMENT_KEYS[p].label), description: t("common", PLACEMENT_KEYS[p].hint) }))}
              />
            </Choice>
          </fieldset>

          {/* K under hrw (F-027-di): only where hrw is the placement in force for this group. */}
          {perBuyerAsked(form, view) && (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-xs font-bold text-text-primary">{t("common", M.perBuyer)}</legend>
              <Choice
                name={t("common", M.perBuyer)}
                value={form.perBuyerMode}
                onChange={(v) => set({ perBuyerMode: v })}
                same={t("common", M.samePanelValue, { value: panelPerBuyer ?? "" })}
                own={t("common", M.own)}
              >
                <Input
                  dir="ltr"
                  inputMode="numeric"
                  value={form.perBuyer}
                  onChange={(e) => set({ perBuyer: e.target.value })}
                  aria-label={t("common", M.perBuyer)}
                  className="sm:max-w-40"
                />
                <span className="text-2xs leading-5 text-text-secondary">{t("common", SYSTEMS_KEYS.inbounds.perBuyerHint)}</span>
                {errors.perBuyer && <Alert tone="error">{t("common", errors.perBuyer)}</Alert>}
              </Choice>
            </fieldset>
          )}

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-xs font-bold text-text-primary">{t("common", M.cap)}</legend>
            <Choice
              name={t("common", M.cap)}
              value={form.capMode}
              onChange={(v) => set({ capMode: v })}
              same={t("common", M.samePanelValue, { value: panelCap ?? "" })}
              own={t("common", M.own)}
            >
              <Input
                dir="ltr"
                inputMode="numeric"
                value={form.maxClients}
                onChange={(e) => set({ maxClients: e.target.value })}
                aria-label={t("common", M.cap)}
                className="sm:max-w-40"
              />
              <span className="text-2xs leading-5 text-text-secondary">{t("common", M.capHint)}</span>
              {errors.maxClients && <Alert tone="error">{t("common", errors.maxClients)}</Alert>}
            </Choice>
          </fieldset>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-xs font-bold text-text-primary">{t("common", M.inbounds)}</legend>
            <Choice
              name={t("common", M.inbounds)}
              value={form.inboundsMode === "pool" ? "panel" : "own"}
              onChange={(v) => set({ inboundsMode: v === "panel" ? "pool" : "own" })}
              same={t("common", M.pool)}
              own={t("common", M.ownInbounds)}
            >
              <span className="text-2xs leading-5 text-text-secondary">{t("common", M.ownInboundsHint)}</span>
              <ul className="divide-y divide-card-border">
                {inboundChoices(view, group.id, lang).map(({ inbound: i, sharedWith, everyGroup, takesNobody }) => (
                  <li key={i.remoteId} className="flex flex-wrap items-center gap-2 py-2 text-xs">
                    <label className="flex min-w-0 flex-1 items-center gap-2">
                      <input
                        type="checkbox"
                        checked={form.picked.includes(i.remoteId)}
                        onChange={(e) => set({ picked: e.target.checked ? [...form.picked, i.remoteId] : form.picked.filter((id) => id !== i.remoteId) })}
                        className="accent-primary"
                      />
                      <span dir="ltr" className="min-w-0 truncate font-mono text-text-primary">
                        {i.protocol ?? "?"} · {i.port}
                        {i.tag && ` · ${i.tag}`}
                      </span>
                    </label>
                    {sharedWith && <Pill tone={QUIET}>{t("common", K.settings.sharedWith, { groups: sharedWith })}</Pill>}
                    {everyGroup && <Pill tone={QUIET}>{t("common", K.settings.everyGroup)}</Pill>}
                    {takesNobody && <Pill tone={BAD}>{t("common", K.settings.takesNobody)}</Pill>}
                  </li>
                ))}
              </ul>
              {errors.inbounds && <Alert tone="error">{t("common", errors.inbounds)}</Alert>}
            </Choice>
            {form.inboundsMode === "pool" && <span className="text-2xs leading-5 text-text-secondary">{t("common", M.poolHint)}</span>}
          </fieldset>

          {preview && sellsNobody(view, preview) && (
            <p className={`flex items-start gap-1 rounded-xl border px-3 py-2 text-xs leading-5 ${BAD}`}>
              <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden />
              {t("common", K.settings.sellsNobody)}
            </p>
          )}
          {errors.form && <Alert tone="error">{t("common", errors.form)}</Alert>}
          {failure && <Alert tone="error">{failure}</Alert>}
        </>
      )}
    </Sheet>
  );
}
