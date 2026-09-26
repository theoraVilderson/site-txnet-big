"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { billingApi, type CapabilityMatrix, type SystemsPanel } from "@/lib/billing-api";
import { formatInstant } from "../../_lib/datetime";
import { Sheet } from "../../catalog/_components/catalog-ui";
import { PANEL_STATE_KEYS, REVIEW_KEYS, SYSTEMS_KEYS as K, capabilityText, refusedBecause } from "../_lib/systems";
import { PanelEditForm } from "./PanelEditForm";
import { PanelInbounds } from "./PanelInbounds";
import { Pill, REVIEW_TONE, STATE_TONE, useSystemsError } from "./parts";

type Part = "general" | "sales" | "capabilities" | "status";
const PARTS: Part[] = ["general", "sales", "capabilities", "status"];

/**
 * Everything about one panel, in one sheet (F-027-ck): its details and
 * connection (rule 13), the inbounds it sells on (rule 12), what the
 * connection test answered (rule 3) and its health. One section at a time,
 * so the card itself stays a line or two.
 */
export function PanelSheet({
  panel,
  initial = "general",
  onClose,
  onSaved,
}: {
  panel: SystemsPanel;
  initial?: Part;
  onClose: () => void;
  /** A saved edit closes the sheet: the card says the sentence and the row is read again. */
  onSaved: (sentence: string) => Promise<void>;
}) {
  const { t } = useLocale();
  const [part, setPart] = useState<Part>(initial);
  // A push panel is never called, so it has no inbounds to read or pick (F-114-b).
  const push = panel.transport === "push";

  return (
    <Sheet title={t("common", K.panelSheet.title, { panel: panel.name })} onClose={onClose}>
      <div role="tablist" className="flex gap-1 overflow-x-auto rounded-xl bg-bg-inner p-1">
        {PARTS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={part === id}
            onClick={() => setPart(id)}
            className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-bold ${part === id ? "bg-primary text-text-on-accent" : "text-text-secondary hover:bg-leaf-bg"}`}
          >
            {t("common", K.panelSheet.tabs[id])}
          </button>
        ))}
      </div>

      {part === "general" && <PanelEditForm panel={panel} onSaved={onSaved} />}
      {part === "sales" &&
        (push ? (
          <p className="rounded-xl bg-bg-inner px-3 py-2 text-xs leading-5 text-text-secondary">{t("common", K.panelSheet.pushNoSales)}</p>
        ) : (
          <>
            <p className="text-xs leading-5 text-text-secondary">{t("common", K.panelSheet.salesIntro)}</p>
            <PanelInbounds panelId={panel.id} />
          </>
        ))}
      {part === "capabilities" && <Matrix panelId={panel.id} />}
      {part === "status" && <Status panel={panel} />}
    </Sheet>
  );
}

/** The panel's health and budget as the loops last wrote them (rule 2): the detail behind the card's one status. */
function Status({ panel }: { panel: SystemsPanel }) {
  const { lang, t } = useLocale();
  const when = (iso: string | null) => formatInstant(iso, lang) ?? t("common", K.never);
  const rows: [string, React.ReactNode][] = [
    [t("common", K.panels.tested), formatInstant(panel.review.connectionTestedAt, lang) ?? t("common", K.panels.notTested)],
    [t("common", K.panels.lastHealthy), when(panel.health.lastHealthyAt)],
    [t("common", K.panels.lastCollected), when(panel.health.lastSuccessfulCollectionAt)],
    [
      t("common", K.edit.budget),
      <>
        {t("common", K.budget.perMinute, { count: String(panel.budget.maxRequestsPerMinute) })}
        {panel.budget.blockedSince && (
          <span className="ms-2 text-error">
            {t("common", K.budget.blockedSince)}: <span dir="ltr">{formatInstant(panel.budget.blockedSince, lang)}</span>
          </span>
        )}
      </>,
    ],
  ];
  return (
    <div className="flex flex-col gap-3">
      <span className="flex flex-wrap items-center gap-2">
        <Pill tone={REVIEW_TONE[panel.review.reviewState]}>{t("common", REVIEW_KEYS[panel.review.reviewState])}</Pill>
        <Pill tone={STATE_TONE[panel.health.panelState]}>{t("common", PANEL_STATE_KEYS[panel.health.panelState])}</Pill>
      </span>
      <dl className="divide-y divide-card-border rounded-xl bg-bg-inner px-3 text-xs">
        {rows.map(([label, value]) => (
          <div key={label} className="flex flex-wrap justify-between gap-2 py-2">
            <dt className="text-text-secondary">{label}</dt>
            <dd className="text-text-primary" dir="auto">
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
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
