"use client";

import { HandCoins, ListOrdered, Pencil, Plus, Trash2, TriangleAlert } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { AdminGateway } from "@/lib/billing-api";
import { Badge, Button } from "../../../_components/kit";
import { transferKind } from "../../../_components/transfer/transfer-kinds";
import { useKindText } from "../WizardProviderPicker";

const G = FrontendI18nKeys.common.gateways;
const M = G.manual;
const T = FrontendI18nKeys.common.transfer;

interface ManualGatewaysSectionProps {
  /** The tenant's manual gateways only (`isManualProvider`), in the list's order. */
  gateways: AdminGateway[];
  onAdd: () => void;
  onEdit: (g: AdminGateway) => void;
  onRemove: (g: AdminGateway) => void;
  onDestinations: (g: AdminGateway) => void;
}

/** The kinds present, in the order their first gateway appears — so a list groups without a second sort. */
function byKind(gateways: AdminGateway[]): [string, AdminGateway[]][] {
  const groups = new Map<string, AdminGateway[]>();
  for (const g of gateways) {
    const kind = g.manual?.kind ?? "";
    groups.set(kind, [...(groups.get(kind) ?? []), g]);
  }
  return [...groups];
}

/**
 * The page's second section (F-803-g): the tenant's manual gateways by kind —
 * each card or wallet set its own gateway, with its own limits, fee and proof
 * (billing "Storage"). A gateway with no active destination is not offered to
 * anyone (F-803-c), so its row says so and its cards are one press away.
 */
export function ManualGatewaysSection({ gateways, onAdd, onEdit, onRemove, onDestinations }: ManualGatewaysSectionProps) {
  const { t } = useLocale();
  const kindText = useKindText();
  const proofName = (id: string) => (id in T.proof ? t("common", T.proof[id as keyof typeof T.proof]) : id);

  return (
    <section className="rounded-3xl border border-card-border bg-card-bg p-5 shadow-sm sm:p-6" aria-labelledby="gw-manual-title">
      <header className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="gw-manual-title" className="flex items-center gap-2 text-sm font-bold text-text-primary">
            <HandCoins size={16} className="text-primary" aria-hidden />
            {t("common", M.sectionTitle)}
          </h2>
          <p className="mt-1 text-xs text-text-secondary">{t("common", M.sectionSubtitle)}</p>
        </div>
        <Button size="sm" onClick={onAdd} icon={<Plus size={14} aria-hidden />}>
          {t("common", M.add)}
        </Button>
      </header>

      {gateways.length === 0 ? (
        <p className="py-4 text-center text-xs text-text-secondary">{t("common", M.empty)}</p>
      ) : (
        byKind(gateways).map(([kind, rows]) => {
          const Icon = transferKind(kind).icon;
          return (
            <div key={kind} className="mt-3 first:mt-0">
              <h3 className="flex items-center gap-2 text-xs font-bold text-text-secondary">
                <Icon size={14} aria-hidden />
                {kindText(kind).title}
              </h3>
              <ul className="divide-y divide-card-border">
                {rows.map((g) => (
                  <li key={`${g.source}:${g.id}`} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div className="flex min-w-0 flex-col gap-1">
                      <span className="flex flex-wrap items-center gap-2 text-sm font-bold text-text-primary">
                        {g.displayName}
                        <span className={`text-3xs font-bold ${g.isActive ? "text-success" : "text-text-secondary"}`}>
                          {g.isActive ? t("common", G.active) : t("common", G.inactive)}
                        </span>
                        <Badge tone="info" className="px-1.5 text-3xs">
                          {t("common", M.byPersonShort)}
                        </Badge>
                      </span>
                      <span className="text-xs text-text-secondary">
                        {t("common", M.destinationCount, { active: String(g.manual?.activeDestinations ?? 0), total: String(g.manual?.destinations ?? 0) })}
                        {" · "}
                        {(g.manual?.requiredProof ?? []).map(proofName).join(" · ")}
                      </span>
                      {(g.manual?.activeDestinations ?? 0) === 0 && (
                        <span role="status" className="inline-flex items-center gap-1 text-xs font-bold text-warning">
                          <TriangleAlert size={12} aria-hidden />
                          {t("common", M.notOffered)}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button size="sm" onClick={() => onDestinations(g)} icon={<ListOrdered size={14} aria-hidden />}>
                        {t("common", M.destinations)}
                      </Button>
                      <Button variant="quiet" size="sm" onClick={() => onEdit(g)} icon={<Pencil size={14} aria-hidden />} className="text-primary hover:text-primary">
                        {t("common", G.edit)}
                      </Button>
                      <Button variant="quiet" size="sm" onClick={() => onRemove(g)} icon={<Trash2 size={14} aria-hidden />} className="text-error hover:bg-error-bg hover:text-error">
                        {t("common", G.delete)}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          );
        })
      )}
    </section>
  );
}
