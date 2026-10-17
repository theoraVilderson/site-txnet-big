"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRightLeft, Layers, Pencil, Plus, Trash2, TriangleAlert } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { PANEL_CATALOG } from "@/lib/routes";
import { billingApi, systemsGroupMovesApi, type PanelGroup, type SystemsPanel } from "@/lib/billing-api";
import { GROUP_MOVE_KEYS } from "../../_lib/group-move";
import { GroupMoveDialog } from "../../_components/group-move/GroupMoveDialog";
import { Field, Sheet } from "../../catalog/_components/catalog-ui";
import { emptyGroupForm, groupFormOf, groupHealth, validateGroup, type GroupForm } from "../_lib/panel-groups";
import { SYSTEMS_KEYS } from "../_lib/systems";
import { DeleteGroupSheet } from "./DeleteGroupSheet";
import { ActionsMenu, BAD, CardButton, GOOD, ListState, Notice, QUIET, Section, useSystemsError, useWait } from "./parts";
import { Alert, Button, Input } from "../../_components/kit";
import { AddMember, MemberRow } from "./GroupMembers";

const K = SYSTEMS_KEYS.groups;
/** The owner's door for a group move (F-027-ev): any group, any tenant's Grants. */
const MOVES = systemsGroupMovesApi();

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
        <Button variant="primary" size="sm" onClick={() => setCreating(true)} className="inline-flex items-center gap-1" icon={<Plus size={14} aria-hidden />}>
          {t("common", K.create)}
        </Button>
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
          <Button variant="quiet" size="sm" onClick={onCancel}>
            {t("common", K.cancel)}
          </Button>
          <Button variant="primary" size="sm" disabled={busy} onClick={() => void submit()}>
            {submitLabel}
          </Button>
        </div>
      }
    >
      <p className="text-xs leading-5 text-text-secondary">{t("common", group ? K.editHint : K.hint)}</p>
      <Field label={t("common", K.field.name)} error={errors.name}>
        <Input value={form.name} maxLength={100} onChange={set("name")} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("common", K.field.minHealthyPanels)} error={errors.minHealthyPanels} hint={t("common", K.field.minHealthyPanelsHint)}>
          <Input dir="ltr" inputMode="numeric" value={form.minHealthyPanels} onChange={set("minHealthyPanels")} />
        </Field>
        <Field label={t("common", K.field.ttlMinutes)} error={errors.ttlMinutes} hint={t("common", K.field.ttlHint)}>
          <Input dir="ltr" inputMode="numeric" value={form.ttlMinutes} onChange={set("ttlMinutes")} />
        </Field>
      </div>
      {failure && <Alert tone="error">{failure}</Alert>}
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
  const message = useSystemsError();
  const [sheet, setSheet] = useState<"edit" | "delete" | "move" | null>(null);
  const health = groupHealth(group);

  return (
    <li className="flex flex-col gap-3 rounded-2xl border border-card-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="flex items-center gap-2 text-sm font-bold text-text-primary">
            <Layers size={14} className="text-primary" aria-hidden />
            {group.name}
          </span>
          <span className="text-2xs text-text-secondary">
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
            items={[
              { label: t("common", GROUP_MOVE_KEYS.open), icon: <ArrowRightLeft size={14} aria-hidden />, onSelect: () => setSheet("move") },
              { label: t("common", SYSTEMS_KEYS.groupsRemove.action), icon: <Trash2 size={14} aria-hidden />, tone: "error", onSelect: () => setSheet("delete") },
            ]}
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

      {sheet === "move" && (
        <GroupMoveDialog
          open
          onClose={() => setSheet(null)}
          api={MOVES}
          source={{ fromGroupId: group.id }}
          sourceLabel={t("common", GROUP_MOVE_KEYS.whole, { group: group.name })}
          message={message}
          onEnded={() => void onChanged()}
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
