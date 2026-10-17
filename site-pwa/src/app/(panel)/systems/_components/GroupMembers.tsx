"use client";

import { useState } from "react";
import { LogOut, SlidersHorizontal } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { billingApi, type EvictOrphans, type EvictPreview, type PanelGroup, type PanelGroupMember, type SystemsPanel } from "@/lib/billing-api";
import { formatInstant } from "../../_lib/datetime";
import { Sheet } from "../../catalog/_components/catalog-ui";
import { DRAIN_TTL_MULTIPLE, MEMBER_ROLE_KEYS, addablePanels, canDrain, canEvict, canRemove, isLastToServe, ORPHAN_CHOICES, drainEarliestAt, memberPlaceable } from "../_lib/panel-groups";
import { PANEL_STATE_KEYS, REVIEW_KEYS, SYSTEMS_KEYS } from "../_lib/systems";
import { OrphanChoice } from "./OrphanChoice";
import { ActionsMenu, BAD, CardButton, GOOD, Notice, Pill, QUIET, REVIEW_TONE, STATE_TONE, useSystemsError, useWait } from "./parts";
import { Button, NativeSelect } from "../../_components/kit";
import { MemberSheet } from "./MemberSheet";

const K = SYSTEMS_KEYS.groups;

/** Whether the member overrides anything of its panel's (billing rules 24b–24c). */
const isCustom = (m: PanelGroupMember) => m.inboundPlacement !== null || m.maxClients !== null || m.inbounds.length > 0;

/**
 * One member in a line (F-027-ck): whether new configs go on it and, when
 * not, why; whether it sells as its panel does. Its selling settings open in
 * a sheet; taking it out of the group — remove or drain — in another.
 */
export function MemberRow({ group, member, onChanged }: { group: PanelGroup; member: PanelGroupMember; onChanged: () => Promise<void> }) {
  const { lang, t } = useLocale();
  const wait = useWait();
  const [sheet, setSheet] = useState<"settings" | "leave" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const earliest = drainEarliestAt(member, group);
  const placeable = memberPlaceable(member);
  const leaving = canDrain(member) || canRemove(member) || canEvict(member);

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
          {member.evictedAt ? (
            <span className="text-text-secondary">{t("common", K.evict.since, { since: formatInstant(member.evictedAt, lang) ?? member.evictedAt })}</span>
          ) : earliest && member.drainingSince ? (
            <>
              <span className="text-text-secondary">
                {t("common", K.drain.since, { since: formatInstant(member.drainingSince, lang) ?? member.drainingSince, at: formatInstant(earliest, lang) ?? earliest })}
              </span>
              {/* Held by the sweep (rule 14): said, with the way out, instead of a wait that silently never ends. */}
              {!!member.heldGrants && <span className="font-bold text-error">{t("common", K.drain.held, { n: member.heldGrants })}</span>}
            </>
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
 * Taking a member out of its group, every way said side by side (rule 11):
 * remove while nothing is on it, drain — with its least wait — while users
 * are and another member can take them, and "remove now" (rule 16) for a
 * panel that is broken or gone, its cost counted before the confirm. A
 * refusal re-reads too: `already_draining` or `member_not_found` means the
 * list is stale.
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
  const [preview, setPreview] = useState<EvictPreview | null>(null);
  const [orphans, setOrphans] = useState<EvictOrphans>(ORPHAN_CHOICES[0]);
  const lastToServe = isLastToServe(member, group);

  /** The cost of "remove now", read before its confirm is offered; the sheet stays open. */
  const check = async () => {
    setBusy(true);
    setFailure(null);
    try {
      setPreview(await billingApi.panelGroupMemberEvictPreview(group.id, member.panelId));
    } catch (e) {
      setFailure(message(e));
      await onChanged();
    } finally {
      setBusy(false);
    }
  };

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
      {canDrain(member) && lastToServe && (
        <div className="rounded-2xl border border-border bg-bg-inner p-4 text-xs leading-5 text-text-secondary">{t("common", K.drain.lastMember)}</div>
      )}
      {canDrain(member) && !lastToServe && (
        <div className="flex flex-col gap-2 rounded-2xl border border-error-border bg-bg-inner p-4">
          <p className="text-xs leading-5 text-text-secondary">{t("common", K.drain.confirmHint, { wait: wait(DRAIN_TTL_MULTIPLE * group.subscriptionTtlSeconds) })}</p>
          <div>
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const answer = await billingApi.drainPanelGroupMember(group.id, member.panelId);
                  return t("common", K.drain.started, { wait: wait(answer.waitSeconds) });
                })
              }
              className="text-error hover:text-error hover:bg-error-bg"
            >
              {t("common", K.drain.submit)}
            </Button>
          </div>
        </div>
      )}
      {canRemove(member) && (
        <div>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void run(async () => (await billingApi.removePanelGroupMember(group.id, member.panelId), null))}
          >
            {t("common", K.remove)}
          </Button>
        </div>
      )}
      {canEvict(member) && (
        <div className="flex flex-col gap-2 rounded-2xl border border-error-border bg-bg-inner p-4">
          <p className="text-sm font-bold text-text-primary">{t("common", K.evict.title)}</p>
          <p className="text-xs leading-5 text-text-secondary">{t("common", K.evict.hint)}</p>
          {preview ? (
            <>
              <OrphanChoice preview={preview} value={orphans} onChange={setOrphans} safe={K.evict.previewSafe} />
              <div>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void run(async () => (await billingApi.evictPanelGroupMember(group.id, member.panelId, orphans), t("common", K.evict.started)))}
                  className="text-error hover:text-error hover:bg-error-bg"
                >
                  {t("common", K.evict.confirm)}
                </Button>
              </div>
            </>
          ) : (
            <div>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void check()}
                className="text-error hover:text-error hover:bg-error-bg"
              >
                {t("common", K.evict.check)}
              </Button>
            </div>
          )}
        </div>
      )}
      {failure && <Notice tone="bad">{failure}</Notice>}
    </Sheet>
  );
}


export function AddMember({ group, panels, onChanged }: { group: PanelGroup; panels: SystemsPanel[]; onChanged: () => Promise<void> }) {
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
          <NativeSelect value={panelId} onChange={(e) => setPanelId(e.target.value)} className="min-w-0 flex-1">
            <option value="">{t("common", K.add.pick)}</option>
            {options.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {t("common", REVIEW_KEYS[p.review.reviewState])}
              </option>
            ))}
          </NativeSelect>
          <Button variant="primary" size="sm" type="submit" disabled={busy || !panelId}>
            {t("common", K.add.submit)}
          </Button>
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
