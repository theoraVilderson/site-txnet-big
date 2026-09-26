"use client";

import { useEffect, useState } from "react";
import { Archive, ChevronDown, ChevronUp, KeyRound, ListChecks, Loader2, Pencil, RotateCcw, Trash2, TriangleAlert } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { billingApi, type CapabilityMatrix, type PanelGroup, type SystemsPanel } from "@/lib/billing-api";
import { formatInstant } from "../../_lib/datetime";
import { Sheet, primaryButton, quietButton } from "../../catalog/_components/catalog-ui";
import { DELETE_OUTCOME_KEYS, groupsHolding, isArchived, visiblePanels } from "../_lib/panel-lifecycle";
import {
  driverLabel,
  FAULT_KEYS,
  PANEL_STATE_KEYS,
  REVIEW_KEYS,
  SYSTEMS_KEYS as K,
  canResubmit,
  canResubmitRadiusSecret,
  capabilityText,
  radiusSecretMissing,
  refusedBecause,
  resubmitOutcome,
  validateLogin,
  validateRadiusSecret,
  verdictOf,
} from "../_lib/systems";
import { ActionsMenu, BAD, CardButton, ListState, Notice, Pill, QUIET, REVIEW_TONE, STATE_TONE, Section, useSystemsError, type MenuItem } from "./parts";
import { PanelEditSheet } from "./PanelEditSheet";
import { PanelInbounds } from "./PanelInbounds";

/**
 * The registered panels as cards (F-027-cb). The everyday actions — edit,
 * inbounds, capabilities — sit on the card; the rarer ones (a new RADIUS
 * secret, delete) behind "more". Archived panels (F-027-bz) are out of the way
 * unless asked for, and read as archived, with restore as their one action.
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

type Open = "inbounds" | "matrix" | null;

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
  const { lang, t } = useLocale();
  // One panel below the card at a time: inbounds or capabilities.
  const [open, setOpen] = useState<Open>(null);
  const [sheet, setSheet] = useState<"edit" | "delete" | null>(null);
  // A push panel is never called, so it has no inbounds to read or pick (F-114-b).
  const hasInbounds = panel.transport !== "push";
  // The RADIUS secret has its own form; the login is in the edit sheet (F-027-az / F-027-by).
  const [editing, setEditing] = useState<Secret | null>(null);
  // The sentence for the last answer; the row itself is read again, never patched.
  const [saved, setSaved] = useState<string | null>(null);
  const verdict = verdictOf(panel);
  const when = (iso: string | null) => formatInstant(iso, lang) ?? t("common", K.never);
  const toggle = (which: Exclude<Open, null>) => setOpen((o) => (o === which ? null : which));

  const openSecret = (secret: Secret) => {
    setEditing(secret);
    setSaved(null);
  };
  const openSheet = (which: "edit" | "delete") => {
    setSheet(which);
    setSaved(null);
  };
  const more: MenuItem[] = [
    ...(canResubmit(panel) ? [{ label: t("common", K.resubmit.open), icon: <KeyRound size={14} aria-hidden />, onSelect: () => openSecret("login") }] : []),
    ...(canResubmitRadiusSecret(panel)
      ? [{ label: t("common", K.radiusSecret.open), icon: <KeyRound size={14} aria-hidden />, onSelect: () => openSecret("radiusSecret") }]
      : []),
    { label: t("common", K.remove.action), icon: <Trash2 size={14} aria-hidden />, tone: "error", onSelect: () => openSheet("delete") },
  ];

  return (
    <li className="flex flex-col gap-3 rounded-2xl border border-card-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-sm font-bold text-text-primary">{panel.name}</span>
          <span dir="ltr" className="font-mono text-[11px] text-text-secondary">
            {driverLabel(panel.driverType)} · {panel.transport} · {panel.role} · {panel.region}
            {(panel.apiBaseUrl ?? panel.ipAddress) && <span className="ms-2 break-all">{panel.apiBaseUrl ?? panel.ipAddress}</span>}
          </span>
          <span className="flex flex-wrap items-center gap-2">
            <Pill tone={REVIEW_TONE[verdict.state]}>{t("common", REVIEW_KEYS[verdict.state])}</Pill>
            <Pill tone={STATE_TONE[panel.health.panelState]}>{t("common", PANEL_STATE_KEYS[panel.health.panelState])}</Pill>
            {panel.health.collectionHalted && (
              <Pill tone={BAD}>
                <TriangleAlert size={10} aria-hidden />
                {t("common", K.panels.halted)}
              </Pill>
            )}
            {radiusSecretMissing(panel) && <Pill tone={BAD}>{t("common", K.radiusSecret.missing)}</Pill>}
            {panel.health.openDriftEvents > 0 && (
              <Pill tone={BAD}>{t("common", K.panels.openDrift, { count: String(panel.health.openDriftEvents) })}</Pill>
            )}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CardButton icon={<Pencil size={14} aria-hidden />} onClick={() => openSheet("edit")}>
            {t("common", K.panels.edit)}
          </CardButton>
          {hasInbounds && (
            <CardButton icon={<ListChecks size={14} aria-hidden />} pressed={open === "inbounds"} onClick={() => toggle("inbounds")}>
              {t("common", K.panels.showInbounds)}
            </CardButton>
          )}
          <CardButton
            icon={open === "matrix" ? <ChevronUp size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
            pressed={open === "matrix"}
            onClick={() => toggle("matrix")}
          >
            {t("common", K.panels.showMatrix)}
          </CardButton>
          <ActionsMenu label={t("common", K.panels.more)} items={more} />
        </div>
      </div>

      {saved && <Notice tone="good">{t("common", saved)}</Notice>}
      {editing !== null && (editing === "login" ? canResubmit(panel) : canResubmitRadiusSecret(panel)) && (
        <SecretForm
          panelId={panel.id}
          secret={editing}
          onDone={async (sentence) => {
            setEditing(null);
            setSaved(sentence);
            await onChanged();
          }}
          onCancel={() => setEditing(null)}
        />
      )}

      <VerdictLine panel={panel} />

      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 rounded-xl bg-bg-inner px-3 py-2 text-xs text-text-secondary sm:grid-cols-4">
        <div>
          <dt className="inline">{t("common", K.panels.tested)}: </dt>
          <dd className="inline" dir="ltr">
            {formatInstant(panel.review.connectionTestedAt, lang) ?? t("common", K.panels.notTested)}
          </dd>
        </div>
        <div>
          <dt className="inline">{t("common", K.panels.lastHealthy)}: </dt>
          <dd className="inline" dir="ltr">{when(panel.health.lastHealthyAt)}</dd>
        </div>
        <div>
          <dt className="inline">{t("common", K.panels.lastCollected)}: </dt>
          <dd className="inline" dir="ltr">{when(panel.health.lastSuccessfulCollectionAt)}</dd>
        </div>
        <div>
          <dt className="inline">{t("common", K.edit.budget)}: </dt>
          <dd className="inline">
            {t("common", K.budget.perMinute, { count: String(panel.budget.maxRequestsPerMinute) })}
            {panel.budget.blockedSince && (
              <span className="ms-2 text-error">
                {t("common", K.budget.blockedSince)}: <span dir="ltr">{formatInstant(panel.budget.blockedSince, lang)}</span>
              </span>
            )}
          </dd>
        </div>
      </dl>

      {hasInbounds && open === "inbounds" && <PanelInbounds panelId={panel.id} />}
      {open === "matrix" && <Matrix panelId={panel.id} />}

      {sheet === "edit" && (
        <PanelEditSheet
          panel={panel}
          onClose={() => setSheet(null)}
          onSaved={async (sentence) => {
            setSheet(null);
            setSaved(sentence);
            await onChanged();
          }}
        />
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
 * A new secret for this panel. A password input, sent once and cleared from
 * state with the form. For the login, the answer's `retest` decides the
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
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3 rounded-2xl border border-card-border bg-bg-inner p-4">
      <p className="text-sm font-bold text-text-primary">{t("common", copy.title)}</p>
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

const CELL_TONE: Record<string, string> = { supported: "text-primary", unsupported: "text-error", unanswered: "text-text-secondary", not_asked: "text-text-secondary" };

/** One panel's questionnaire, fetched when opened. The question and the cost of a `no` are said here, by key. */
function Matrix({ panelId }: { panelId: string }) {
  const { lang, t } = useLocale();
  const message = useSystemsError();
  const [matrix, setMatrix] = useState<CapabilityMatrix | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let live = true;
    billingApi.panelCapabilities(panelId).then(
      (m) => live && setMatrix(m),
      (e: unknown) => live && setError(e),
    );
    return () => {
      live = false;
    };
  }, [panelId]);

  if (error) {
    return (
      <p role="alert" className="text-xs font-bold text-error">
        {message(error)}
      </p>
    );
  }
  if (!matrix) {
    return (
      <p className="flex items-center gap-2 text-xs text-text-secondary">
        <Loader2 size={14} className="animate-spin" aria-hidden />
        {t("common", K.loading)}
      </p>
    );
  }

  const why = refusedBecause(matrix.rows);
  const names = (keys: string[]) => keys.map((k) => capabilityText(k)?.question ?? k);

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-card-border bg-bg-inner p-4">
      <p className="text-sm font-bold text-text-primary">
        {t("common", K.matrix.title)}
        {matrix.answeredAt && (
          <span className="ms-2 text-xs font-normal text-text-secondary">
            {t("common", K.matrix.answeredAt)}: <span dir="ltr">{formatInstant(matrix.answeredAt, lang)}</span>
          </span>
        )}
      </p>
      {!matrix.current && matrix.documentVersion !== null && <p className="text-xs text-text-secondary">{t("common", K.matrix.stale)}</p>}
      {matrix.reviewState === "refused" && why.refused.length > 0 && (
        <div className="text-xs text-error">
          <p className="font-bold">{t("common", K.matrix.refusedBecause)}</p>
          <ul className="list-inside list-disc">
            {names(why.refused).map((q) => (
              <li key={q}>{t("common", q)}</li>
            ))}
          </ul>
        </div>
      )}
      {matrix.reviewState !== "refused" && why.noMeteredSale.length > 0 && (
        <div className="text-xs text-text-primary">
          <p className="font-bold">{t("common", K.matrix.noMeteredSale)}</p>
          <ul className="list-inside list-disc">
            {names(why.noMeteredSale).map((q) => (
              <li key={q}>{t("common", q)}</li>
            ))}
          </ul>
        </div>
      )}
      <ul className="divide-y divide-card-border">
        {matrix.rows.map((row) => {
          const text = capabilityText(row.key);
          const state = row.state in K.matrix.state ? K.matrix.state[row.state as keyof typeof K.matrix.state] : null;
          const severity = row.severity in K.matrix.severity ? K.matrix.severity[row.severity as keyof typeof K.matrix.severity] : null;
          return (
            <li key={row.key} className="flex flex-col gap-1 py-2 text-xs">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <span className="min-w-0 text-text-primary">{text ? t("common", text.question) : <span dir="ltr" className="font-mono">{row.key}</span>}</span>
                <span className="flex shrink-0 items-center gap-2">
                  {severity && <span className="text-[10px] text-text-secondary">{t("common", severity)}</span>}
                  <span className={`font-bold ${CELL_TONE[row.state] ?? "text-text-secondary"}`}>{state ? t("common", state) : row.state}</span>
                </span>
              </div>
              {row.state === "unsupported" && text && (
                <p className="text-text-secondary">
                  {t("common", K.matrix.unmetLabel)}: {t("common", text.unmet)}
                  {row.detail && (
                    <span dir="ltr" className="ms-2 font-mono">
                      ({row.detail})
                    </span>
                  )}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
