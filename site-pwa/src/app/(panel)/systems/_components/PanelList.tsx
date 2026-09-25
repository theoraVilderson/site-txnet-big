"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, KeyRound, ListChecks, Loader2, TriangleAlert } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { billingApi, type CapabilityMatrix, type SystemsPanel } from "@/lib/billing-api";
import { formatInstant } from "../../_lib/datetime";
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
import { BAD, ListState, Pill, REVIEW_TONE, STATE_TONE, Section, useSystemsError } from "./parts";
import { PanelInbounds } from "./PanelInbounds";

export function PanelList({
  panels,
  isLoading,
  error,
  onRetry,
}: {
  panels: SystemsPanel[];
  isLoading: boolean;
  error: unknown;
  onRetry: () => Promise<void>;
}) {
  const { t } = useLocale();
  return (
    <Section title={t("common", K.panels.title)}>
      <ListState isLoading={isLoading} error={error} empty={panels.length === 0 ? K.panels.empty : null} onRetry={() => void onRetry()}>
        <ul className="divide-y divide-card-border">
          {panels.map((p) => (
            <PanelItem key={p.id} panel={p} onChanged={onRetry} />
          ))}
        </ul>
      </ListState>
    </Section>
  );
}

function PanelItem({ panel, onChanged }: { panel: SystemsPanel; onChanged: () => Promise<void> }) {
  const { lang, t } = useLocale();
  const [open, setOpen] = useState(false);
  // A push panel is never called, so it has no inbounds to read or pick (F-114-b).
  const [inboundsOpen, setInboundsOpen] = useState(false);
  const hasInbounds = panel.transport !== "push";
  // Which secret is being re-submitted: the login, or a push panel's RADIUS secret (F-027-az).
  const [editing, setEditing] = useState<Secret | null>(null);
  // The sentence for the last answer; the row itself is read again, never patched.
  const [saved, setSaved] = useState<string | null>(null);
  const verdict = verdictOf(panel);
  const when = (iso: string | null) => formatInstant(iso, lang) ?? t("common", K.never);

  return (
    <li className="flex flex-col gap-3 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2 text-sm font-bold text-text-primary">
            {panel.name}
            <span dir="ltr" className="font-mono text-[11px] font-normal text-text-secondary">
              {driverLabel(panel.driverType)} · {panel.transport} · {panel.role} · {panel.region}
            </span>
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
        <div className="flex items-center gap-2">
          {canResubmit(panel) && editing === null && (
            <button
              type="button"
              onClick={() => {
                setEditing("login");
                setSaved(null);
              }}
              className="inline-flex items-center gap-1 rounded-xl border border-card-border px-3 py-2 text-xs font-bold text-text-primary hover:bg-leaf-bg"
            >
              <KeyRound size={14} aria-hidden />
              {t("common", K.resubmit.open)}
            </button>
          )}
          {canResubmitRadiusSecret(panel) && editing === null && (
            <button
              type="button"
              onClick={() => {
                setEditing("radiusSecret");
                setSaved(null);
              }}
              className="inline-flex items-center gap-1 rounded-xl border border-card-border px-3 py-2 text-xs font-bold text-text-primary hover:bg-leaf-bg"
            >
              <KeyRound size={14} aria-hidden />
              {t("common", K.radiusSecret.open)}
            </button>
          )}
          {hasInbounds && (
            <button
              type="button"
              onClick={() => setInboundsOpen((o) => !o)}
              aria-expanded={inboundsOpen}
              className="inline-flex items-center gap-1 rounded-xl border border-card-border px-3 py-2 text-xs font-bold text-text-primary hover:bg-leaf-bg"
            >
              <ListChecks size={14} aria-hidden />
              {t("common", inboundsOpen ? K.panels.hideInbounds : K.panels.showInbounds)}
            </button>
          )}
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="inline-flex items-center gap-1 rounded-xl border border-card-border px-3 py-2 text-xs font-bold text-text-primary hover:bg-leaf-bg"
          >
            {open ? <ChevronUp size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
            {t("common", open ? K.panels.hideMatrix : K.panels.showMatrix)}
          </button>
        </div>
      </div>

      {saved && (
        <p role="status" className="text-xs font-bold text-primary">
          {t("common", saved)}
        </p>
      )}
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

      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs text-text-secondary sm:grid-cols-3">
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
      </dl>

      <div className="rounded-2xl border border-card-border bg-bg-inner p-3 text-xs leading-5 text-text-secondary">
        <p className="font-bold text-text-primary">
          {t("common", K.budget.perMinute, { count: String(panel.budget.maxRequestsPerMinute) })}
          {panel.budget.blockedSince && (
            <span className="ms-2 text-error">
              {t("common", K.budget.blockedSince)}: <span dir="ltr">{formatInstant(panel.budget.blockedSince, lang)}</span>
            </span>
          )}
        </p>
        <p>{t("common", K.budget.tradeOff)}</p>
      </div>

      {hasInbounds && inboundsOpen && <PanelInbounds panelId={panel.id} />}
      {open && <Matrix panelId={panel.id} />}
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
        ? t("common", K.review.refusedHint)
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
