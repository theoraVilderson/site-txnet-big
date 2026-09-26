"use client";

import { useState } from "react";
import { Archive, KeyRound, Loader2, RotateCcw, Settings2, Trash2, TriangleAlert } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { billingApi, type PanelGroup, type SystemsPanel } from "@/lib/billing-api";
import { formatInstant } from "../../_lib/datetime";
import { Sheet, primaryButton, quietButton } from "../../catalog/_components/catalog-ui";
import { DELETE_OUTCOME_KEYS, groupsHolding, isArchived, visiblePanels } from "../_lib/panel-lifecycle";
import { PANEL_STATUS_KEYS, panelStatusOf, type PanelStatus } from "../_lib/systems-guide";
import {
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
import { PanelSheet } from "./PanelSheet";

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

const STATUS_TONE: Record<PanelStatus, string> = { ready: GOOD, limited: QUIET, testing: QUIET, refused: BAD, problem: BAD, archived: QUIET };

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
    { label: t("common", K.remove.action), icon: <Trash2 size={14} aria-hidden />, tone: "error", onSelect: () => open("delete") },
  ];

  return (
    <li className="flex flex-col gap-3 rounded-2xl border border-card-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-bold text-text-primary">{panel.name}</span>
            <Pill tone={STATUS_TONE[status]}>{t("common", PANEL_STATUS_KEYS[status].label)}</Pill>
          </span>
          <span dir="ltr" className="truncate text-start font-mono text-[11px] text-text-secondary">
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
        <SecretForm panelId={panel.id} secret={sheet} onDone={done} onCancel={() => setSheet(null)} />
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
  const reasons = [
    panel.health.collectionHalted && t("common", K.panels.halted),
    (panel.health.panelState === "down" || panel.health.panelState === "throttled_or_blocked") && t("common", PANEL_STATE_KEYS[panel.health.panelState]),
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
    </div>
  );
}

/**
 * Delete, said before it happens: deleted if it never had users, archived if
 * it had (billing rules 7–8). A panel a group holds is not offered the button
 * — the sheet names the groups instead (rule 6); a live config outside any
 * group is billing's to refuse, and its sentence is shown here.
 */
function DeleteSheet({ panel, holding, onClose, onDone }: { panel: SystemsPanel; holding: string[]; onClose: () => void; onDone: (sentence: string) => Promise<void> }) {
  const { lang, t } = useLocale();
  const message = useSystemsError();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const blocked = holding.length > 0;
  const names = new Intl.ListFormat(lang, { type: "conjunction" }).format(holding);

  const remove = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const answer = await billingApi.deletePanel(panel.id);
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
          <button type="button" onClick={onClose} className={quietButton}>
            {t("common", K.groups.cancel)}
          </button>
          {!blocked && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void remove()}
              className="inline-flex items-center gap-1.5 rounded-xl border border-error-border bg-error-bg px-3 py-2 text-xs font-bold text-error disabled:opacity-50"
            >
              <Trash2 size={14} aria-hidden />
              {t("common", K.remove.submit)}
            </button>
          )}
        </div>
      }
    >
      <p className="text-sm leading-6 text-text-secondary">{t("common", K.remove.hint)}</p>
      {blocked && <Notice tone="bad">{t("common", K.remove.blockedGroups, { groups: names })}</Notice>}
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
        <button type="button" disabled={busy} onClick={() => void restore()} className={primaryButton}>
          {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <RotateCcw size={14} aria-hidden />}
          {t("common", K.panels.restore)}
        </button>
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
 * A new secret for this panel, in a sheet. A password input, sent once and
 * cleared from state with the form. For the login, the answer's `retest` decides the
 * sentence; a RADIUS secret re-tests nothing.
 */
function SecretForm({
  panelId,
  secret,
  onDone,
  onCancel,
}: {
  panelId: string;
  secret: Secret;
  onDone: (sentence: string) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useLocale();
  const message = useSystemsError();
  const copy = SECRET_FORM[secret];
  const [login, setLogin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const answer = await copy.send(panelId, login);
      if ("error" in answer) {
        setError(t("common", answer.error));
        return;
      }
      setLogin("");
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
      <label className="flex flex-col gap-1 text-xs text-text-secondary">
        {t("common", copy.field)}
        <input
          dir="ltr"
          type="password"
          autoComplete="off"
          value={login}
          maxLength={4096}
          onChange={(e) => setLogin(e.target.value)}
          className="rounded-xl border border-card-border bg-card-bg px-3 py-2 font-mono text-sm text-text-primary"
        />
        {error && <span className="text-error">{error}</span>}
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy} className="rounded-xl bg-primary px-4 py-2 text-xs font-bold text-text-on-accent disabled:opacity-50">
          {t("common", copy.submit)}
        </button>
        <button type="button" onClick={onCancel} className="rounded-xl px-4 py-2 text-xs font-medium text-text-secondary hover:bg-leaf-bg">
          {t("common", K.resubmit.cancel)}
        </button>
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
