"use client";

import { useEffect, useState } from "react";
import { Layers, Loader2, Pencil, Plus, SlidersHorizontal, Trash2, TriangleAlert } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { billingApi, type PanelGroup, type PanelGroupMember, type PanelInbounds, type SystemsPanel } from "@/lib/billing-api";
import { formatInstant } from "../../_lib/datetime";
import { Alert, Field, Sheet, input, primaryButton, quietButton } from "../../catalog/_components/catalog-ui";
import { groupDeleteBlock } from "../_lib/panel-lifecycle";
import { INBOUND_PLACEMENTS, PLACEMENT_KEYS } from "../_lib/panel-inbounds";
import {
  LAYER_KEYS,
  inboundChoices,
  memberFormOf,
  sellsNobody,
  validateMember,
  validateMemberInbounds,
  type MemberForm,
} from "../_lib/member-settings";
import {
  DRAIN_TTL_MULTIPLE,
  MEMBER_ROLE_KEYS,
  addablePanels,
  canDrain,
  canRemove,
  drainEarliestAt,
  emptyGroupForm,
  groupFormOf,
  groupHealth,
  memberPlaceable,
  validateGroup,
  waitOf,
  type GroupForm,
} from "../_lib/panel-groups";
import { PANEL_STATE_KEYS, REVIEW_KEYS, SYSTEMS_KEYS } from "../_lib/systems";
import { BAD, CardButton, GOOD, ListState, Notice, Pill, QUIET, REVIEW_TONE, STATE_TONE, Section, useSystemsError } from "./parts";

const K = SYSTEMS_KEYS.groups;

const INPUT = "rounded-xl border border-card-border bg-card-bg px-3 py-2 text-sm text-text-primary";
const PRIMARY = "rounded-xl bg-primary px-4 py-2 text-xs font-bold text-text-on-accent disabled:opacity-50";
const SECONDARY = "rounded-xl px-4 py-2 text-xs font-medium text-text-secondary hover:bg-leaf-bg";

/** "2 h", "3 days" — a wait as the sweep counts it, never rounded down. */
function useWait(): (seconds: number) => string {
  const { t } = useLocale();
  return (seconds) => {
    const { key, n } = waitOf(seconds);
    return t("common", key, { n: String(n) });
  };
}

/**
 * Panel groups (F-027-bx -> billing F-027-bw, network `contract.groups.md`):
 * where a VPN variant's Grants are placed. Create and edit a group, add a
 * registered panel, remove a member with nothing on it or drain one with its
 * wait stated. Every write re-reads the list; nothing is patched in from an
 * answer, since fulfilment and the drain sweep act on the rows, not the page.
 */
export function PanelGroups({
  groups,
  panels,
  isLoading,
  error,
  onChanged,
}: {
  groups: PanelGroup[];
  panels: SystemsPanel[];
  isLoading: boolean;
  error: unknown;
  onChanged: () => Promise<void>;
}) {
  const { t } = useLocale();
  const [creating, setCreating] = useState(false);
  // A deleted group's card is gone, so its sentence is the section's.
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <Section
      title={t("common", K.title)}
      hint={t("common", K.hint)}
      actions={
        <button type="button" onClick={() => setCreating(true)} className={`inline-flex items-center gap-1 ${PRIMARY}`}>
          <Plus size={14} aria-hidden />
          {t("common", K.create)}
        </button>
      }
    >
      {notice && <Notice tone="good">{t("common", notice)}</Notice>}
      {creating && (
        <GroupEditor
          title={t("common", K.create)}
          submitLabel={t("common", K.createSubmit)}
          onDone={async () => {
            setCreating(false);
            await onChanged();
          }}
          onCancel={() => setCreating(false)}
        />
      )}
      <ListState isLoading={isLoading} error={error} empty={groups.length === 0 ? K.empty : null} onRetry={() => void onChanged()}>
        <ul className="flex flex-col gap-4">
          {groups.map((g) => (
            <GroupCard key={g.id} group={g} panels={panels} onChanged={onChanged} onNotice={setNotice} />
          ))}
        </ul>
      </ListState>
    </Section>
  );
}

/** Create, or — with `group` — edit, in a sheet: only what changed is sent (`validateGroup`). */
function GroupEditor({
  group,
  title,
  submitLabel,
  onDone,
  onCancel,
}: {
  group?: PanelGroup;
  title: string;
  submitLabel: string;
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useLocale();
  const message = useSystemsError();
  const [form, setForm] = useState<GroupForm>(() => (group ? groupFormOf(group) : emptyGroupForm()));
  const [errors, setErrors] = useState<Partial<Record<keyof GroupForm, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (field: keyof GroupForm) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [field]: e.target.value }));

  const submit = async () => {
    const checked = validateGroup(form, group);
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    setFailure(null);
    setBusy(true);
    try {
      if (group) await billingApi.updatePanelGroup(group.id, checked.body);
      else await billingApi.createPanelGroup(checked.body as typeof checked.body & { name: string });
      await onDone();
    } catch (e) {
      setFailure(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={title}
      onClose={onCancel}
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button type="button" onClick={onCancel} className={quietButton}>
            {t("common", K.cancel)}
          </button>
          <button type="button" disabled={busy} onClick={() => void submit()} className={primaryButton}>
            {submitLabel}
          </button>
        </div>
      }
    >
      <p className="text-xs leading-5 text-text-secondary">{t("common", group ? K.editHint : K.hint)}</p>
      <Field label={t("common", K.field.name)} error={errors.name}>
        <input value={form.name} maxLength={100} onChange={set("name")} className={input} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("common", K.field.minHealthyPanels)} error={errors.minHealthyPanels} hint={t("common", K.field.minHealthyPanelsHint)}>
          <input dir="ltr" inputMode="numeric" value={form.minHealthyPanels} onChange={set("minHealthyPanels")} className={input} />
        </Field>
        <Field label={t("common", K.field.ttlMinutes)} error={errors.ttlMinutes} hint={t("common", K.field.ttlHint)}>
          <input dir="ltr" inputMode="numeric" value={form.ttlMinutes} onChange={set("ttlMinutes")} className={input} />
        </Field>
      </div>
      {failure && <Alert>{failure}</Alert>}
    </Sheet>
  );
}

/**
 * Delete a group (F-027-ca, billing rule 24a). The button is offered only on
 * an empty group no variant names; otherwise the sheet says what to do first.
 */
function DeleteGroupSheet({ group, onClose, onDone }: { group: PanelGroup; onClose: () => void; onDone: () => Promise<void> }) {
  const { t } = useLocale();
  const message = useSystemsError();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const block = groupDeleteBlock(group);

  const remove = async () => {
    setBusy(true);
    setFailure(null);
    try {
      await billingApi.deletePanelGroup(group.id);
      await onDone();
    } catch (e) {
      setFailure(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={t("common", SYSTEMS_KEYS.groupsRemove.title, { group: group.name })}
      onClose={onClose}
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button type="button" onClick={onClose} className={quietButton}>
            {t("common", K.cancel)}
          </button>
          {!block && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void remove()}
              className="inline-flex items-center gap-1.5 rounded-xl border border-error-border bg-error-bg px-3 py-2 text-xs font-bold text-error disabled:opacity-50"
            >
              <Trash2 size={14} aria-hidden />
              {t("common", SYSTEMS_KEYS.groupsRemove.submit)}
            </button>
          )}
        </div>
      }
    >
      {block ? (
        <Notice tone="bad">{t("common", block.key, { n: String(block.n) })}</Notice>
      ) : (
        <p className="text-sm leading-6 text-text-secondary">{t("common", SYSTEMS_KEYS.groupsRemove.hint)}</p>
      )}
      {failure && <Notice tone="bad">{failure}</Notice>}
    </Sheet>
  );
}

function GroupCard({
  group,
  panels,
  onChanged,
  onNotice,
}: {
  group: PanelGroup;
  panels: SystemsPanel[];
  onChanged: () => Promise<void>;
  onNotice: (sentence: string) => void;
}) {
  const { t } = useLocale();
  const wait = useWait();
  const [sheet, setSheet] = useState<"edit" | "delete" | null>(null);
  const health = groupHealth(group);

  return (
    <li className="flex flex-col gap-3 rounded-2xl border border-card-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="flex items-center gap-2 text-sm font-bold text-text-primary">
            <Layers size={14} className="text-primary" aria-hidden />
            {group.name}
          </span>
          <span className="flex flex-wrap gap-2">
            <Pill tone={QUIET}>{t("common", SYSTEMS_KEYS.groupsMembersCount, { n: String(group.members.length) })}</Pill>
            <Pill tone={QUIET}>{t("common", K.variants, { n: String(group.variantCount) })}</Pill>
            <Pill tone={QUIET}>{t("common", K.ttl, { wait: wait(group.subscriptionTtlSeconds) })}</Pill>
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CardButton icon={<Pencil size={14} aria-hidden />} onClick={() => setSheet("edit")}>
            {t("common", K.edit)}
          </CardButton>
          <CardButton icon={<Trash2 size={14} aria-hidden />} tone="error" onClick={() => setSheet("delete")}>
            {t("common", SYSTEMS_KEYS.groupsRemove.action)}
          </CardButton>
        </div>
      </div>

      <p className={`flex items-start gap-1 rounded-xl border px-3 py-2 text-xs leading-5 ${health.short ? BAD : GOOD}`}>
        {health.short && <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden />}
        {t("common", health.short ? K.health.short : K.health.ok, { placeable: String(health.placeable), min: String(health.min) })}
      </p>

      {sheet === "edit" && (
        <GroupEditor
          group={group}
          title={`${t("common", K.edit)} — ${group.name}`}
          submitLabel={t("common", K.editSubmit)}
          onDone={async () => {
            setSheet(null);
            await onChanged();
          }}
          onCancel={() => setSheet(null)}
        />
      )}
      {sheet === "delete" && (
        <DeleteGroupSheet
          group={group}
          onClose={() => setSheet(null)}
          onDone={async () => {
            setSheet(null);
            onNotice(SYSTEMS_KEYS.groupsRemove.deleted);
            await onChanged();
          }}
        />
      )}

      <p className="border-t border-card-border pt-3 text-xs font-bold text-text-primary">{t("common", K.members.title)}</p>
      {group.members.length === 0 ? (
        <p className="text-xs text-text-secondary">{t("common", K.members.empty)}</p>
      ) : (
        <ul className="divide-y divide-card-border">
          {group.members.map((m) => (
            <MemberRow key={m.panelId} group={group} member={m} onChanged={onChanged} />
          ))}
        </ul>
      )}
      <AddMember group={group} panels={panels} onChanged={onChanged} />
    </li>
  );
}

function MemberRow({ group, member, onChanged }: { group: PanelGroup; member: PanelGroupMember; onChanged: () => Promise<void> }) {
  const { lang, t } = useLocale();
  const message = useSystemsError();
  const wait = useWait();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [started, setStarted] = useState<number | null>(null);
  const [settings, setSettings] = useState(false);

  const run = async (call: () => Promise<unknown>) => {
    setBusy(true);
    setFailure(null);
    try {
      await call();
      setConfirming(false);
    } catch (e) {
      setFailure(message(e));
    } finally {
      // A refusal re-reads too: `already_draining` or `member_not_found` means the list is stale.
      await onChanged();
      setBusy(false);
    }
  };

  const earliest = drainEarliestAt(member, group);
  const placeable = memberPlaceable(member);

  return (
    <li className="flex flex-col gap-2 py-3 text-xs">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-bold text-text-primary">{member.panelName}</span>
            <Pill tone={member.role === "drain" ? BAD : QUIET}>{t("common", MEMBER_ROLE_KEYS[member.role])}</Pill>
            <Pill tone={REVIEW_TONE[member.reviewState]}>{t("common", REVIEW_KEYS[member.reviewState])}</Pill>
            <Pill tone={STATE_TONE[member.panelState]}>{t("common", PANEL_STATE_KEYS[member.panelState])}</Pill>
          </span>
          {member.role !== "drain" && (
            <span className={placeable ? "text-primary" : "text-text-secondary"}>
              {t("common", placeable ? K.members.placed : K.members.waiting)}
            </span>
          )}
          {earliest && member.drainingSince && (
            <span className="text-text-secondary">
              {t("common", K.drain.since, { since: formatInstant(member.drainingSince, lang) ?? member.drainingSince, at: formatInstant(earliest, lang) ?? earliest })}
            </span>
          )}
          <MemberSummary member={member} />
        </div>
        {!confirming && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-pressed={settings}
              onClick={() => setSettings((open) => !open)}
              className="inline-flex items-center gap-1 rounded-xl border border-card-border px-3 py-2 text-xs font-bold text-text-primary hover:bg-leaf-bg"
            >
              <SlidersHorizontal size={14} aria-hidden />
              {t("common", K.settings.action)}
            </button>
            {canDrain(member) && (
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirming(true)}
                className="rounded-xl border border-error-border px-3 py-2 text-xs font-bold text-error hover:bg-error-bg disabled:opacity-50"
              >
                {t("common", K.drain.action)}
              </button>
            )}
            {canRemove(member) && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => billingApi.removePanelGroupMember(group.id, member.panelId))}
                className="rounded-xl px-3 py-2 text-xs font-medium text-text-secondary hover:bg-leaf-bg disabled:opacity-50"
              >
                {t("common", K.remove)}
              </button>
            )}
          </div>
        )}
      </div>
      {settings && <MemberSettings group={group} member={member} onChanged={onChanged} />}
      {confirming && (
        <div className="flex flex-col gap-3 rounded-2xl border border-error-border bg-bg-inner p-4">
          <p className="text-sm font-bold text-error">{t("common", K.drain.confirmTitle, { panel: member.panelName })}</p>
          <p className="leading-5 text-text-secondary">{t("common", K.drain.confirmHint, { wait: wait(DRAIN_TTL_MULTIPLE * group.subscriptionTtlSeconds) })}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const answer = await billingApi.drainPanelGroupMember(group.id, member.panelId);
                  setStarted(answer.waitSeconds);
                })
              }
              className="rounded-xl border border-error-border bg-error-bg px-4 py-2 text-xs font-bold text-error disabled:opacity-50"
            >
              {t("common", K.drain.submit)}
            </button>
            <button type="button" onClick={() => setConfirming(false)} className={SECONDARY}>
              {t("common", K.cancel)}
            </button>
          </div>
        </div>
      )}
      {started !== null && member.role === "drain" && (
        <p role="status" className="font-bold text-primary">
          {t("common", K.drain.started, { wait: wait(started) })}
        </p>
      )}
      {failure && (
        <p role="alert" className="font-bold text-error">
          {failure}
        </p>
      )}
    </li>
  );
}

/** What the member sells with, each value beside the layer it comes from (billing rule 24b), and whose inbounds (rule 24c). */
function MemberSummary({ member }: { member: PanelGroupMember }) {
  const { t } = useLocale();
  const { inboundPlacement: placement, maxClients: cap } = member.effective;
  const layer = (l: keyof typeof LAYER_KEYS) => t("common", LAYER_KEYS[l]);
  return (
    <span className="flex flex-wrap gap-2">
      <Pill tone={placement.layer === "member" ? GOOD : QUIET}>
        {t("common", PLACEMENT_KEYS[placement.value].label)} · {layer(placement.layer)}
      </Pill>
      <Pill tone={cap.layer === "member" ? GOOD : QUIET}>
        {t("common", SYSTEMS_KEYS.inbounds.cap)}: {cap.value === null ? t("common", K.settings.noCap) : cap.value} · {layer(cap.layer)}
      </Pill>
      <Pill tone={member.inbounds.length > 0 ? GOOD : QUIET}>
        {member.inbounds.length > 0 ? t("common", K.settings.own, { count: String(member.inbounds.length) }) : t("common", K.settings.pool)}
      </Pill>
    </span>
  );
}

/**
 * How this group sells on this member's panel (F-027-ci): its own placement
 * and cap over the panel's, and the inbounds its membership holds. The
 * panel's inbounds are read when opened — they carry the panel's layer, which
 * is what "inherit" means here, and which group holds each inbound.
 */
function MemberSettings({ group, member, onChanged }: { group: PanelGroup; member: PanelGroupMember; onChanged: () => Promise<void> }) {
  const { t } = useLocale();
  const message = useSystemsError();
  const [view, setView] = useState<PanelInbounds | null>(null);
  const [form, setForm] = useState<MemberForm>(() => memberFormOf(member));
  const [picked, setPicked] = useState<string[]>(member.inbounds);
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const read = () => billingApi.panelInbounds(member.panelId).then(setView, (e: unknown) => setFailure(message(e)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void read(), [member.panelId]);

  const act = async (work: () => Promise<unknown>, saved: string) => {
    setBusy(true);
    setFailure(null);
    setStatus(null);
    try {
      await work();
      setStatus(saved);
    } catch (e) {
      setFailure(message(e));
    } finally {
      // A refusal re-reads too: another group may have taken an inbound meanwhile.
      await Promise.all([onChanged(), read()]);
      setBusy(false);
    }
  };

  const saveSettings = () => {
    const checked = validateMember(form, member);
    if (!checked.ok) return setErrors(checked.errors);
    setErrors({});
    void act(() => billingApi.updatePanelGroupMember(group.id, member.panelId, checked.body), K.settings.saved);
  };

  const saveInbounds = () => {
    const checked = validateMemberInbounds(picked, member);
    if (!checked.ok) return setErrors({ inbounds: checked.error });
    setErrors({});
    void act(() => billingApi.setPanelGroupMemberInbounds(group.id, member.panelId, checked.inbounds), K.settings.savedInbounds);
  };

  const inherited = view?.effective;
  const toggle = (remoteId: string, on: boolean) => setPicked((p) => (on ? [...p, remoteId] : p.filter((id) => id !== remoteId)));

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-card-border bg-bg-inner p-4">
      <p className="text-sm font-bold text-text-primary">{t("common", K.settings.title, { panel: member.panelName })}</p>
      <p className="leading-5 text-text-secondary">{t("common", K.settings.hint)}</p>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-text-secondary">
          {t("common", K.settings.placement)}
          <select value={form.placement} onChange={(e) => setForm({ ...form, placement: e.target.value as MemberForm["placement"] })} className={INPUT}>
            <option value="">
              {inherited
                ? t("common", K.settings.inheritValue, { value: `${t("common", PLACEMENT_KEYS[inherited.inboundPlacement.value].label)} (${t("common", LAYER_KEYS[inherited.inboundPlacement.layer])})` })
                : t("common", K.settings.inherit)}
            </option>
            {INBOUND_PLACEMENTS.map((p) => (
              <option key={p} value={p}>
                {t("common", PLACEMENT_KEYS[p].label)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-text-secondary">
          {t("common", K.settings.cap)}
          <input
            dir="ltr"
            inputMode="numeric"
            value={form.maxClients}
            placeholder={inherited ? (inherited.maxClients.value === null ? t("common", K.settings.noCap) : String(inherited.maxClients.value)) : ""}
            onChange={(e) => setForm({ ...form, maxClients: e.target.value })}
            className={INPUT}
          />
          <span className="leading-5">{t("common", K.settings.capHint)}</span>
          {errors.maxClients && <span className="text-error">{t("common", errors.maxClients)}</span>}
        </label>
      </div>
      {errors.form && <p className="text-error">{t("common", errors.form)}</p>}
      <div>
        <button type="button" disabled={busy} onClick={saveSettings} className={PRIMARY}>
          {t("common", K.settings.save)}
        </button>
      </div>

      <p className="border-t border-card-border pt-3 font-bold text-text-primary">{t("common", K.settings.inbounds)}</p>
      <p className="leading-5 text-text-secondary">{t("common", K.settings.inboundsHint)}</p>
      {!view ? (
        <p className="flex items-center gap-2 text-text-secondary">
          <Loader2 size={14} className="animate-spin" aria-hidden />
          {t("common", K.settings.loading)}
        </p>
      ) : (
        <>
          {sellsNobody(view, member) && (
            <p className={`flex items-start gap-1 rounded-xl border px-3 py-2 leading-5 ${BAD}`}>
              <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden />
              {t("common", K.settings.sellsNobody)}
            </p>
          )}
          <ul className="divide-y divide-card-border">
            {inboundChoices(view, group.id).map(({ inbound: i, heldBy, takesNobody }) => (
              <li key={i.remoteId} className="flex flex-wrap items-center gap-3 py-2">
                <label className="flex min-w-0 flex-1 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={picked.includes(i.remoteId)}
                    disabled={heldBy !== null}
                    onChange={(e) => toggle(i.remoteId, e.target.checked)}
                    className="accent-primary"
                  />
                  <span dir="ltr" className="min-w-0 truncate font-mono text-text-primary">
                    #{i.remoteId} · {i.protocol ?? "?"} · {i.port}
                    {i.tag && ` · ${i.tag}`}
                  </span>
                </label>
                {heldBy && <Pill tone={QUIET}>{t("common", K.settings.heldBy, { group: heldBy.name })}</Pill>}
                {!heldBy && takesNobody && <Pill tone={BAD}>{t("common", K.settings.takesNobody)}</Pill>}
              </li>
            ))}
          </ul>
          {errors.inbounds && <p className="text-error">{t("common", errors.inbounds)}</p>}
          <div>
            <button type="button" disabled={busy} onClick={saveInbounds} className={PRIMARY}>
              {t("common", K.settings.saveInbounds)}
            </button>
          </div>
        </>
      )}

      {failure && (
        <p role="alert" className="font-bold text-error">
          {failure}
        </p>
      )}
      {status && (
        <p role="status" className="font-bold text-primary">
          {t("common", status)}
        </p>
      )}
    </div>
  );
}

function AddMember({ group, panels, onChanged }: { group: PanelGroup; panels: SystemsPanel[]; onChanged: () => Promise<void> }) {
  const { t } = useLocale();
  const message = useSystemsError();
  const [panelId, setPanelId] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const options = addablePanels(panels, group);

  if (options.length === 0) return <p className="text-xs text-text-secondary">{t("common", K.add.none)}</p>;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!panelId) return;
    setBusy(true);
    setFailure(null);
    try {
      await billingApi.addPanelGroupMember(group.id, panelId);
      setPanelId("");
    } catch (e) {
      setFailure(message(e));
    } finally {
      await onChanged();
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-2">
      <label className="flex flex-col gap-1 text-xs text-text-secondary">
        {t("common", K.add.label)}
        <span className="flex flex-wrap gap-2">
          <select value={panelId} onChange={(e) => setPanelId(e.target.value)} className={`min-w-0 flex-1 ${INPUT}`}>
            <option value="">{t("common", K.add.pick)}</option>
            {options.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {t("common", REVIEW_KEYS[p.review.reviewState])}
              </option>
            ))}
          </select>
          <button type="submit" disabled={busy || !panelId} className={PRIMARY}>
            {t("common", K.add.submit)}
          </button>
        </span>
        <span className="leading-5">{t("common", K.add.hint)}</span>
      </label>
      {failure && (
        <p role="alert" className="text-xs font-bold text-error">
          {failure}
        </p>
      )}
    </form>
  );
}
