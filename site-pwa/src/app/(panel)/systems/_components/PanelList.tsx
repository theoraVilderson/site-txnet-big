"use client";

import { useState } from "react";
import { Archive, KeyRound, Loader2, RotateCcw, Settings2, Trash2, TriangleAlert } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { billingApi, type EvictOrphans, type PanelGroup, type PanelRemovePreview, type SystemsPanel } from "@/lib/billing-api";
import { formatInstant } from "../../_lib/datetime";
import { Sheet } from "../../catalog/_components/catalog-ui";
import { ORPHAN_CHOICES } from "../_lib/panel-groups";
import { DELETE_OUTCOME_KEYS, checkNewLogin, groupsHolding, isArchived, isRemoving, visiblePanels, type NewLoginErrors } from "../_lib/panel-lifecycle";
import { emptyLoginParts, type LoginParts } from "../_lib/register-wizard";
import { PANEL_STATUS_KEYS, panelStatusOf, type PanelStatus } from "../_lib/systems-guide";
import {
  CAUSE_KEYS,
  driverLabel,
  FAULT_KEYS,
  PANEL_STATE_KEYS,
  SYSTEMS_KEYS as K,
  canResubmit,
  canResubmitRadiusSecret,
  radiusSecretMissing,
  resubmitOutcome,
  validateLogin,
  validateRadiusSecret,
  verdictOf,
} from "../_lib/systems";
import { ActionsMenu, BAD, CardButton, GOOD, ListState, Notice, Pill, QUIET, Section, useSystemsError, type MenuItem } from "./parts";
import { OrphanChoice } from "./OrphanChoice";
import { PanelLoginFields } from "./PanelLoginFields";
import { PanelSheet } from "./PanelSheet";
import { Button, Field, Input } from "../../_components/kit";

/**
 * The registered panels as cards (F-027-cb, F-027-ck). A card is a line or
 * two — status and "Settings"; the rarer actions (a new login or RADIUS
 * secret, delete) behind "more". Archived panels (F-027-bz) are out of the
 * way unless asked for, and read as archived, with restore as their one action.
 */
export function PanelList({
  panels,
  groups,
  isLoading,
  error,
  onRetry,
}: {
  panels: SystemsPanel[];
  /** Who holds each panel: the delete names them rather than offering what billing would refuse. */
  groups: PanelGroup[];
  isLoading: boolean;
  error: unknown;
  onRetry: () => Promise<void>;
}) {
  const { t } = useLocale();
  const [showArchived, setShowArchived] = useState(false);
  // A delete or a restore moves the card, so its sentence is the list's, not the card's.
  const [notice, setNotice] = useState<string | null>(null);
  const archived = panels.filter(isArchived).length;
  const shown = visiblePanels(panels, showArchived);
  return (
    <Section
      title={t("common", K.panels.title)}
      hint={t("common", K.tabs.panelsHint)}
      actions={
        archived > 0 && (
          <CardButton icon={<Archive size={14} aria-hidden />} pressed={showArchived} onClick={() => setShowArchived((v) => !v)}>
            {t("common", showArchived ? K.panels.hideArchived : K.panels.showArchived, { n: String(archived) })}
          </CardButton>
        )
      }
    >
      {notice && <Notice tone="good">{t("common", notice)}</Notice>}
      <ListState isLoading={isLoading} error={error} empty={shown.length === 0 ? K.panels.empty : null} onRetry={() => void onRetry()}>
        <ul className="flex flex-col gap-4">
          {shown.map((p) =>
            isArchived(p) ? (
              <ArchivedItem key={p.id} panel={p} onChanged={onRetry} onNotice={setNotice} />
            ) : (
              <PanelItem key={p.id} panel={p} groups={groups} onChanged={onRetry} onNotice={setNotice} />
            ),
          )}
        </ul>
      </ListState>
    </Section>
  );
}

const STATUS_TONE: Record<PanelStatus, string> = {
  ready: GOOD,
  limited: QUIET,
  testing: QUIET,
  refused: BAD,
  onHold: QUIET,
  notChecked: BAD,
  problem: BAD,
  archived: QUIET,
};

/**
 * One panel as a card (F-027-ck): its name, one status and the sentence
 * that explains it, and "Settings", which opens everything else. A new
 * login, a RADIUS secret and delete sit behind "more" (rule 13).
 */
function PanelItem({
  panel,
  groups,
  onChanged,
  onNotice,
}: {
  panel: SystemsPanel;
  groups: PanelGroup[];
  onChanged: () => Promise<void>;
  onNotice: (sentence: string) => void;
}) {
  const { t } = useLocale();
  const [sheet, setSheet] = useState<"settings" | "delete" | Secret | null>(null);
  // The sentence for the last answer; the row itself is read again, never patched.
  const [saved, setSaved] = useState<string | null>(null);
  const status = panelStatusOf(panel);
  const address = panel.apiBaseUrl ?? panel.ipAddress;

  const open = (which: NonNullable<typeof sheet>) => {
    setSheet(which);
    setSaved(null);
  };
  const done = async (sentence: string) => {
    setSheet(null);
    setSaved(sentence);
    await onChanged();
  };
  const more: MenuItem[] = [
    ...(canResubmit(panel) ? [{ label: t("common", K.resubmit.open), icon: <KeyRound size={14} aria-hidden />, onSelect: () => open("login") }] : []),
    ...(canResubmitRadiusSecret(panel)
      ? [{ label: t("common", K.radiusSecret.open), icon: <KeyRound size={14} aria-hidden />, onSelect: () => open("radiusSecret") }]
      : []),
    // Being deleted (F-027-eh): the sweep is taking it out; there is nothing left to ask.
    ...(isRemoving(panel) ? [] : [{ label: t("common", K.remove.action), icon: <Trash2 size={14} aria-hidden />, tone: "error" as const, onSelect: () => open("delete") }]),
  ];

  return (
    <li className="flex flex-col gap-3 rounded-2xl border border-card-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-bold text-text-primary">{panel.name}</span>
            <Pill tone={STATUS_TONE[status]}>{t("common", PANEL_STATUS_KEYS[status].label)}</Pill>
            {isRemoving(panel) && <Pill tone={BAD}>{t("common", K.panels.removing)}</Pill>}
          </span>
          <span dir="ltr" className="truncate text-start font-mono text-2xs text-text-secondary">
            {driverLabel(panel.driverType)}
            {panel.region && ` · ${panel.region}`}
            {address && ` · ${address}`}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <CardButton icon={<Settings2 size={14} aria-hidden />} onClick={() => open("settings")}>
            {t("common", K.panelSheet.open)}
          </CardButton>
          <ActionsMenu label={t("common", K.panels.more)} items={more} />
        </div>
      </div>

      {saved && <Notice tone="good">{t("common", saved)}</Notice>}
      <StatusLine panel={panel} status={status} />

      {sheet === "settings" && <PanelSheet panel={panel} onClose={() => setSheet(null)} onSaved={done} />}
      {(sheet === "login" || sheet === "radiusSecret") && (
        <SecretForm panel={panel} secret={sheet} onDone={done} onCancel={() => setSheet(null)} />
      )}
      {sheet === "delete" && (
        <DeleteSheet
          panel={panel}
          holding={groupsHolding(panel, groups)}
          onClose={() => setSheet(null)}
          onDone={async (sentence) => {
            setSheet(null);
            onNotice(sentence);
            await onChanged();
          }}
        />
      )}
    </li>
  );
}

/**
 * The status in a sentence, only when it is not simply "ready": what the
 * test answered (`VerdictLine`), or what is stopping an accepted panel.
 */
function StatusLine({ panel, status }: { panel: SystemsPanel; status: PanelStatus }) {
  const { lang, t } = useLocale();
  if (status === "ready") return null;
  if (status === "testing" || status === "refused") return <VerdictLine panel={panel} />;
  // The outage is ours (ADR-0122): the reason is said once over the list, and nothing about the panel is.
  if (status === "onHold") {
    return <p className={`rounded-xl border px-3 py-2 text-xs leading-5 ${QUIET}`}>{t("common", PANEL_STATUS_KEYS.onHold.hint)}</p>;
  }
  const { cause, since, checkedAt, panelState } = panel.health;
  const at = (iso: string | null) => formatInstant(iso, lang) ?? "";
  const unwell = panelState === "down" || panelState === "degraded" || panelState === "throttled_or_blocked";
  const reasons = [
    panel.health.collectionHalted && t("common", K.panels.halted),
    // The cause says what to fix (F-027-em); a state with none, written before ADR-0122, says only its name.
    unwell && (cause ? t("common", CAUSE_KEYS[cause]) : t("common", PANEL_STATE_KEYS[panelState])),
    panel.budget.blockedSince && `${t("common", K.budget.blockedSince)} ${formatInstant(panel.budget.blockedSince, lang) ?? ""}`,
    radiusSecretMissing(panel) && t("common", K.radiusSecret.missing),
  ].filter((r): r is string => Boolean(r));
  return (
    <div className={`flex flex-col gap-1 rounded-xl border px-3 py-2 text-xs leading-5 ${status === "problem" ? BAD : QUIET}`}>
      <p className="flex items-start gap-1.5">
        {status === "problem" && <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden />}
        {t("common", PANEL_STATUS_KEYS[status].hint)}
      </p>
      {reasons.length > 0 && (
        <ul className="list-inside list-disc ps-5 font-bold">
          {reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      {panel.health.openDriftEvents > 0 && <p>{t("common", K.panels.openDrift, { count: String(panel.health.openDriftEvents) })}</p>}
      {(unwell || status === "notChecked") && (
        <p className="text-text-secondary">
          {unwell && since && `${t("common", K.health.since, { at: at(since) })} · `}
          {checkedAt ? t("common", K.health.checked, { at: at(checkedAt) }) : t("common", K.health.neverChecked)}
        </p>
      )}
    </div>
  );
}

/**
 * Delete, said before it happens: deleted if it never had users, archived if
 * it had (billing rules 7–8). A panel a group holds is deleted in one step
 * (F-027-eh): the sheet names the groups, reads what leaving them now costs,
 * and asks what happens to anyone left with no line before the confirm. A
 * live config outside any group is billing's to refuse, and its sentence is
 * shown here.
 */
function DeleteSheet({ panel, holding, onClose, onDone }: { panel: SystemsPanel; holding: string[]; onClose: () => void; onDone: (sentence: string) => Promise<void> }) {
  const { lang, t } = useLocale();
  const message = useSystemsError();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const inGroups = holding.length > 0;
  const names = new Intl.ListFormat(lang, { type: "conjunction" }).format(holding);
  const [preview, setPreview] = useState<PanelRemovePreview | null>(null);
  const [orphans, setOrphans] = useState<EvictOrphans>(ORPHAN_CHOICES[0]);
  // In groups, the cost is read first; the delete is offered only beside it.
  const ready = !inGroups || preview !== null;

  const check = async () => {
    setBusy(true);
    setFailure(null);
    try {
      setPreview(await billingApi.panelRemovePreview(panel.id));
    } catch (e) {
      setFailure(message(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const answer = await billingApi.deletePanel(panel.id, inGroups ? orphans : undefined);
      await onDone(DELETE_OUTCOME_KEYS[answer.outcome]);
    } catch (e) {
      setFailure(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={t("common", K.remove.title, { panel: panel.name })}
      onClose={onClose}
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="quiet" size="sm" onClick={onClose}>
            {t("common", K.groups.cancel)}
          </Button>
          {inGroups && !preview && (
            <Button size="sm" disabled={busy} onClick={() => void check()} className="text-error hover:text-error hover:bg-error-bg">
              {t("common", K.remove.check)}
            </Button>
          )}
          {ready && (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void remove()}
              icon={<Trash2 size={14} aria-hidden />}
              className="text-error hover:text-error hover:bg-error-bg"
            >
              {t("common", K.remove.submit)}
            </Button>
          )}
        </div>
      }
    >
      <p className="text-sm leading-6 text-text-secondary">{t("common", K.remove.hint)}</p>
      {inGroups && <Notice tone="bad">{t("common", K.remove.inGroups, { groups: names })}</Notice>}
      {preview && <OrphanChoice preview={preview} value={orphans} onChange={setOrphans} safe={K.remove.previewSafe} />}
      {failure && <Notice tone="bad">{failure}</Notice>}
    </Sheet>
  );
}

/** An archived panel (F-027-bz): muted, when it was archived, and restore — which re-tests it first. */
function ArchivedItem({ panel, onChanged, onNotice }: { panel: SystemsPanel; onChanged: () => Promise<void>; onNotice: (sentence: string) => void }) {
  const { lang, t } = useLocale();
  const message = useSystemsError();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const restore = async () => {
    setBusy(true);
    setFailure(null);
    try {
      await billingApi.restorePanel(panel.id);
      onNotice(K.panels.restored);
      await onChanged();
    } catch (e) {
      setFailure(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="flex flex-col gap-2 rounded-2xl border border-dashed border-card-border bg-bg-inner p-4 opacity-90">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2 text-sm font-bold text-text-secondary">
            {panel.name}
            <Pill tone={QUIET}>
              <Archive size={10} aria-hidden />
              {t("common", K.panels.archived)}
            </Pill>
          </span>
          <span className="text-xs text-text-secondary">
            {t("common", K.panels.archivedHint, { when: formatInstant(panel.retiredAt, lang) ?? "" })}
          </span>
        </div>
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void restore()} icon={busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <RotateCcw size={14} aria-hidden />}>
          {t("common", K.panels.restore)}
        </Button>
      </div>
      {failure && <Notice tone="bad">{failure}</Notice>}
    </li>
  );
}

type Secret = "login" | "radiusSecret";
/** A value refused before the call (its sentence key), or the sentence for billing's answer. */
type Sent = { error: string } | { sentence: string };

/** What each form says and sends: the login (F-027-au) or a push panel's RADIUS secret (F-027-az). */
const SECRET_FORM = {
  login: {
    title: K.resubmit.title,
    hint: K.resubmit.hint,
    field: K.register.field.credentials,
    submit: K.resubmit.submit,
    send: async (panelId: string, value: string): Promise<Sent> => {
      const checked = validateLogin(value);
      if (!checked.ok) return { error: checked.error };
      return { sentence: resubmitOutcome(await billingApi.resubmitPanelLogin(panelId, checked.credentials)) };
    },
  },
  radiusSecret: {
    title: K.radiusSecret.title,
    hint: K.radiusSecret.hint,
    field: K.register.field.radiusSecret,
    submit: K.radiusSecret.submit,
    send: async (panelId: string, value: string): Promise<Sent> => {
      const checked = validateRadiusSecret(value);
      if (!checked.ok) return { error: checked.error };
      await billingApi.resubmitPanelRadiusSecret(panelId, checked.radiusSecret);
      return { sentence: K.radiusSecret.saved };
    },
  },
} satisfies Record<Secret, unknown>;

/**
 * A new secret for this panel, in a sheet, sent once and cleared from state
 * with the form. The login is asked in its parts (`PanelLoginFields`) and the
 * answer's `retest` decides the sentence; a RADIUS secret is one password
 * input and re-tests nothing.
 */
function SecretForm({
  panel,
  secret,
  onDone,
  onCancel,
}: {
  panel: SystemsPanel;
  secret: Secret;
  onDone: (sentence: string) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useLocale();
  const message = useSystemsError();
  const copy = SECRET_FORM[secret];
  const [login, setLogin] = useState("");
  const [parts, setParts] = useState<LoginParts>(emptyLoginParts);
  const [partErrors, setPartErrors] = useState<NewLoginErrors>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    let value = login;
    if (secret === "login") {
      const checked = checkNewLogin(panel.driverType, parts, true);
      if (!checked.ok) {
        setPartErrors(checked.errors);
        return;
      }
      value = checked.credentials ?? "";
    }
    setPartErrors({});
    setBusy(true);
    setError(null);
    try {
      const answer = await copy.send(panel.id, value);
      if ("error" in answer) {
        setError(t("common", answer.error));
        return;
      }
      setLogin("");
      setParts(emptyLoginParts());
      await onDone(answer.sentence);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title={t("common", copy.title)} onClose={onCancel}>
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
      <p className="text-xs leading-5 text-text-secondary">{t("common", copy.hint)}</p>
      {secret === "login" ? (
        <>
          <PanelLoginFields
            driverType={panel.driverType}
            parts={parts}
            errors={partErrors}
            onChange={(field, value) => setParts((p) => ({ ...p, [field]: value }))}
          />
          {error && <p className="text-xs text-error">{error}</p>}
        </>
      ) : (
        <Field label={t("common", copy.field)} error={error ? error : undefined}>
          <Input
            dir="ltr"
            type="password"
            autoComplete="off"
            value={login}
            maxLength={4096}
            onChange={(e) => setLogin(e.target.value)}
            className="font-mono"
          />
        </Field>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="sm" type="submit" disabled={busy}>
          {t("common", copy.submit)}
        </Button>
        <Button variant="quiet" size="sm" onClick={onCancel}>
          {t("common", K.resubmit.cancel)}
        </Button>
      </div>
    </form>
    </Sheet>
  );
}

/** The verdict in a sentence: waiting, waiting after a fault (not a verdict), low trust, or refused. */
function VerdictLine({ panel }: { panel: SystemsPanel }) {
  const { t } = useLocale();
  const { state, fault } = verdictOf(panel);
  if (state === "accepted") return null;
  const text =
    state === "pending"
      ? fault
        ? `${t("common", K.review.faultHint)} ${t("common", FAULT_KEYS[fault])}`
        : t("common", K.review.pendingHint)
      : state === "refused"
        ? panel.review.duplicateOf
          ? t("common", K.review.duplicateOf, { panel: panel.review.duplicateOf.name })
          : t("common", K.review.refusedHint)
        : t("common", K.review.lowTrustHint);
  return (
    <p className={`text-xs ${state === "refused" ? "font-bold text-error" : "text-text-secondary"}`}>
      {text}
      {panel.review.connectionTestDetail && (
        <span dir="ltr" className="ms-2 font-mono font-normal text-text-secondary">
          ({panel.review.connectionTestDetail})
        </span>
      )}
    </p>
  );
}
