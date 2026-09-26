"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft, Layers, Loader2, LogOut, Pencil, Plus, SlidersHorizontal, Trash2, TriangleAlert } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { PANEL_CATALOG } from "@/lib/routes";
import { billingApi, type PanelGroup, type PanelGroupMember, type PanelInbounds, type SystemsPanel } from "@/lib/billing-api";
import { formatInstant } from "../../_lib/datetime";
import { Alert, Field, Sheet, input, primaryButton, quietButton } from "../../catalog/_components/catalog-ui";
import { groupDeleteBlock } from "../_lib/panel-lifecycle";
import { INBOUND_PLACEMENTS, PLACEMENT_KEYS } from "../_lib/panel-inbounds";
import { inboundChoices, memberChoiceOf, sellsNobody, validateMemberChoice, type MemberChoice, type MemberChoiceErrors } from "../_lib/member-settings";
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
import { ActionsMenu, BAD, CardButton, GOOD, ListState, Notice, Pill, QUIET, REVIEW_TONE, STATE_TONE, Section, useSystemsError } from "./parts";

const K = SYSTEMS_KEYS.groups;

const INPUT = "rounded-xl border border-card-border bg-card-bg px-3 py-2 text-sm text-text-primary";
const PRIMARY = "rounded-xl bg-primary px-4 py-2 text-xs font-bold text-text-on-accent disabled:opacity-50";

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
          <span className="text-[11px] text-text-secondary">
            {t("common", SYSTEMS_KEYS.groupCard.meta, {
              members: String(group.members.length),
              variants: String(group.variantCount),
              wait: wait(group.subscriptionTtlSeconds),
            })}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <CardButton icon={<Pencil size={14} aria-hidden />} onClick={() => setSheet("edit")}>
            {t("common", K.edit)}
          </CardButton>
          <ActionsMenu
            label={t("common", SYSTEMS_KEYS.panels.more)}
            items={[{ label: t("common", SYSTEMS_KEYS.groupsRemove.action), icon: <Trash2 size={14} aria-hidden />, tone: "error", onSelect: () => setSheet("delete") }]}
          />
        </div>
      </div>

      <p className={`flex items-start gap-1 rounded-xl border px-3 py-2 text-xs leading-5 ${health.short ? BAD : GOOD}`}>
        {health.short && <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden />}
        {t("common", health.short ? K.health.short : K.health.ok, { placeable: String(health.placeable), min: String(health.min) })}
      </p>
      {group.variantCount === 0 && (
        <div className={`flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2 text-xs leading-5 ${QUIET}`}>
          <span className="min-w-0 flex-1">{t("common", SYSTEMS_KEYS.groupCard.noProduct)}</span>
          <Link href={PANEL_CATALOG} className="inline-flex items-center gap-1 font-bold text-primary">
            {t("common", SYSTEMS_KEYS.groupCard.toCatalog)}
            <ArrowLeft size={14} className="ltr:rotate-180" aria-hidden />
          </Link>
        </div>
      )}

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

/** Whether the member overrides anything of its panel's (billing rules 24b–24c). */
const isCustom = (m: PanelGroupMember) => m.inboundPlacement !== null || m.maxClients !== null || m.inbounds.length > 0;

/**
 * One member in a line (F-027-ck): whether new configs go on it and, when
 * not, why; whether it sells as its panel does. Its selling settings open in
 * a sheet; taking it out of the group — remove or drain — in another.
 */
function MemberRow({ group, member, onChanged }: { group: PanelGroup; member: PanelGroupMember; onChanged: () => Promise<void> }) {
  const { lang, t } = useLocale();
  const wait = useWait();
  const [sheet, setSheet] = useState<"settings" | "leave" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const earliest = drainEarliestAt(member, group);
  const placeable = memberPlaceable(member);
  const leaving = canDrain(member) || canRemove(member);

  return (
    <li className="flex flex-col gap-2 py-3 text-xs">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-bold text-text-primary">{member.panelName}</span>
            {member.role === "drain" ? (
              <Pill tone={BAD}>{t("common", MEMBER_ROLE_KEYS.drain)}</Pill>
            ) : (
              <Pill tone={placeable ? GOOD : QUIET}>{t("common", placeable ? K.members.placed : K.members.waiting)}</Pill>
            )}
            {/* Why it waits: only the column that is not yet well. */}
            {member.role !== "drain" && !placeable && member.reviewState !== "accepted" && member.reviewState !== "accepted_low_trust" && (
              <Pill tone={REVIEW_TONE[member.reviewState]}>{t("common", REVIEW_KEYS[member.reviewState])}</Pill>
            )}
            {member.role !== "drain" && !placeable && member.panelState !== "healthy" && (
              <Pill tone={STATE_TONE[member.panelState]}>{t("common", PANEL_STATE_KEYS[member.panelState])}</Pill>
            )}
          </span>
          {earliest && member.drainingSince ? (
            <span className="text-text-secondary">
              {t("common", K.drain.since, { since: formatInstant(member.drainingSince, lang) ?? member.drainingSince, at: formatInstant(earliest, lang) ?? earliest })}
            </span>
          ) : (
            <span className={isCustom(member) ? "font-bold text-primary" : "text-text-secondary"}>
              {t("common", isCustom(member) ? SYSTEMS_KEYS.member.summary.custom : SYSTEMS_KEYS.member.summary.same)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <CardButton icon={<SlidersHorizontal size={14} aria-hidden />} onClick={() => (setSheet("settings"), setNotice(null))}>
            {t("common", K.settings.action)}
          </CardButton>
          {leaving && (
            <ActionsMenu
              label={t("common", SYSTEMS_KEYS.panels.more)}
              items={[{ label: t("common", SYSTEMS_KEYS.member.leave.title), icon: <LogOut size={14} aria-hidden />, tone: "error", onSelect: () => (setSheet("leave"), setNotice(null)) }]}
            />
          )}
        </div>
      </div>
      {notice && <Notice tone="good">{notice}</Notice>}
      {sheet === "settings" && (
        <MemberSheet
          group={group}
          member={member}
          onClose={() => setSheet(null)}
          onSaved={async () => {
            setSheet(null);
            setNotice(t("common", SYSTEMS_KEYS.member.saved));
            await onChanged();
          }}
          onChanged={onChanged}
        />
      )}
      {sheet === "leave" && (
        <LeaveSheet
          group={group}
          member={member}
          onClose={() => setSheet(null)}
          onDone={async (sentence) => {
            setSheet(null);
            if (sentence) setNotice(sentence);
            await onChanged();
          }}
          onChanged={onChanged}
          wait={wait}
        />
      )}
    </li>
  );
}

/**
 * Taking a member out of its group, both ways said side by side (rule 11):
 * remove while nothing is on it, drain — with its least wait — while users
 * are. A refusal re-reads too: `already_draining` or `member_not_found`
 * means the list is stale.
 */
function LeaveSheet({
  group,
  member,
  onClose,
  onDone,
  onChanged,
  wait,
}: {
  group: PanelGroup;
  member: PanelGroupMember;
  onClose: () => void;
  onDone: (sentence: string | null) => Promise<void>;
  onChanged: () => Promise<void>;
  wait: (seconds: number) => string;
}) {
  const { t } = useLocale();
  const message = useSystemsError();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const run = async (call: () => Promise<string | null>) => {
    setBusy(true);
    setFailure(null);
    try {
      await onDone(await call());
    } catch (e) {
      setFailure(message(e));
      await onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title={t("common", K.drain.confirmTitle, { panel: member.panelName })} onClose={onClose}>
      <p className="text-sm leading-6 text-text-secondary">{t("common", SYSTEMS_KEYS.member.leave.hint)}</p>
      {canDrain(member) && (
        <div className="flex flex-col gap-2 rounded-2xl border border-error-border bg-bg-inner p-4">
          <p className="text-xs leading-5 text-text-secondary">{t("common", K.drain.confirmHint, { wait: wait(DRAIN_TTL_MULTIPLE * group.subscriptionTtlSeconds) })}</p>
          <div>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const answer = await billingApi.drainPanelGroupMember(group.id, member.panelId);
                  return t("common", K.drain.started, { wait: wait(answer.waitSeconds) });
                })
              }
              className="rounded-xl border border-error-border bg-error-bg px-4 py-2 text-xs font-bold text-error disabled:opacity-50"
            >
              {t("common", K.drain.submit)}
            </button>
          </div>
        </div>
      )}
      {canRemove(member) && (
        <div>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(async () => (await billingApi.removePanelGroupMember(group.id, member.panelId), null))}
            className="rounded-xl border border-card-border px-4 py-2 text-xs font-bold text-text-primary hover:bg-leaf-bg disabled:opacity-50"
          >
            {t("common", K.remove)}
          </button>
        </div>
      )}
      {failure && <Notice tone="bad">{failure}</Notice>}
    </Sheet>
  );
}

/** "Same as the panel" or this group's own, said as a choice (F-027-ck), with what "the panel" means right now. */
function Choice({ name, value, onChange, same, own, children }: { name: string; value: "panel" | "own"; onChange: (v: "panel" | "own") => void; same: string; own: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      {(["panel", "own"] as const).map((v) => (
        <label key={v} className={`flex items-start gap-2 rounded-xl border px-3 py-2 text-xs ${value === v ? "border-primary/40 bg-leaf-bg" : "border-card-border"}`}>
          <input type="radio" name={name} checked={value === v} onChange={() => onChange(v)} className="mt-0.5 accent-primary" />
          <span className="font-bold text-text-primary">{v === "panel" ? same : own}</span>
        </label>
      ))}
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
function MemberSheet({
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
  const { t } = useLocale();
  const message = useSystemsError();
  const M = SYSTEMS_KEYS.member;
  const [view, setView] = useState<PanelInbounds | null>(null);
  const [form, setForm] = useState<MemberChoice | null>(null);
  const [errors, setErrors] = useState<MemberChoiceErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    billingApi.panelInbounds(member.panelId).then(
      (v) => {
        if (!live) return;
        setView(v);
        setForm((f) => f ?? memberChoiceOf(member, v));
      },
      (e: unknown) => live && setFailure(message(e)),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // What the form would sell right now, so the warning follows the ticks, not the saved row.
  const preview = form && { ...member, inbounds: form.inboundsMode === "pool" ? [] : form.picked };

  return (
    <Sheet
      title={t("common", M.title, { group: group.name, panel: member.panelName })}
      onClose={onClose}
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button type="button" onClick={onClose} className={quietButton}>
            {t("common", K.cancel)}
          </button>
          <button type="button" disabled={busy || !form} onClick={() => void save()} className={primaryButton}>
            {t("common", M.save)}
          </button>
        </div>
      }
    >
      <p className="text-xs leading-5 text-text-secondary">{t("common", M.intro)}</p>
      {!view || !form ? (
        failure ? (
          <Alert>{failure}</Alert>
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
              name={`placement-${member.panelId}`}
              value={form.placementMode}
              onChange={(v) => set({ placementMode: v })}
              same={t("common", M.samePanelValue, { value: panelPlacement ?? "" })}
              own={t("common", M.own)}
            >
              {INBOUND_PLACEMENTS.map((p) => (
                <label key={p} className="flex items-start gap-2 text-xs">
                  <input type="radio" name={`placement-own-${member.panelId}`} checked={form.placement === p} onChange={() => set({ placement: p })} className="mt-0.5 accent-primary" />
                  <span className="flex flex-col">
                    <span className="font-bold text-text-primary">{t("common", PLACEMENT_KEYS[p].label)}</span>
                    <span className="leading-5 text-text-secondary">{t("common", PLACEMENT_KEYS[p].hint)}</span>
                  </span>
                </label>
              ))}
            </Choice>
          </fieldset>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-xs font-bold text-text-primary">{t("common", M.cap)}</legend>
            <Choice
              name={`cap-${member.panelId}`}
              value={form.capMode}
              onChange={(v) => set({ capMode: v })}
              same={t("common", M.samePanelValue, { value: panelCap ?? "" })}
              own={t("common", M.own)}
            >
              <input
                dir="ltr"
                inputMode="numeric"
                value={form.maxClients}
                onChange={(e) => set({ maxClients: e.target.value })}
                aria-label={t("common", M.cap)}
                className={`${input} sm:max-w-40`}
              />
              <span className="text-[11px] leading-5 text-text-secondary">{t("common", M.capHint)}</span>
              {errors.maxClients && <Alert>{t("common", errors.maxClients)}</Alert>}
            </Choice>
          </fieldset>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-xs font-bold text-text-primary">{t("common", M.inbounds)}</legend>
            <Choice
              name={`inbounds-${member.panelId}`}
              value={form.inboundsMode === "pool" ? "panel" : "own"}
              onChange={(v) => set({ inboundsMode: v === "panel" ? "pool" : "own" })}
              same={t("common", M.pool)}
              own={t("common", M.ownInbounds)}
            >
              <span className="text-[11px] leading-5 text-text-secondary">{t("common", M.ownInboundsHint)}</span>
              <ul className="divide-y divide-card-border">
                {inboundChoices(view, group.id).map(({ inbound: i, heldBy, takesNobody }) => (
                  <li key={i.remoteId} className="flex flex-wrap items-center gap-2 py-2 text-xs">
                    <label className="flex min-w-0 flex-1 items-center gap-2">
                      <input
                        type="checkbox"
                        checked={form.picked.includes(i.remoteId)}
                        disabled={heldBy !== null}
                        onChange={(e) => set({ picked: e.target.checked ? [...form.picked, i.remoteId] : form.picked.filter((id) => id !== i.remoteId) })}
                        className="accent-primary"
                      />
                      <span dir="ltr" className="min-w-0 truncate font-mono text-text-primary">
                        {i.protocol ?? "?"} · {i.port}
                        {i.tag && ` · ${i.tag}`}
                      </span>
                    </label>
                    {heldBy && <Pill tone={QUIET}>{t("common", K.settings.heldBy, { group: heldBy.name })}</Pill>}
                    {!heldBy && takesNobody && <Pill tone={BAD}>{t("common", K.settings.takesNobody)}</Pill>}
                  </li>
                ))}
              </ul>
              {errors.inbounds && <Alert>{t("common", errors.inbounds)}</Alert>}
            </Choice>
            {form.inboundsMode === "pool" && <span className="text-[11px] leading-5 text-text-secondary">{t("common", M.poolHint)}</span>}
          </fieldset>

          {preview && sellsNobody(view, preview) && (
            <p className={`flex items-start gap-1 rounded-xl border px-3 py-2 text-xs leading-5 ${BAD}`}>
              <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden />
              {t("common", K.settings.sellsNobody)}
            </p>
          )}
          {errors.form && <Alert>{t("common", errors.form)}</Alert>}
          {failure && <Alert>{failure}</Alert>}
        </>
      )}
    </Sheet>
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
