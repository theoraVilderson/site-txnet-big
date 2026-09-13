"use client";

import { useState } from "react";
import { KeyRound, Landmark, Pencil, Plus, RotateCw, Trash2 } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { billingApi, type AdminGateway, type GatewaySecretState } from "@/lib/billing-api";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { Skeleton } from "../../_components/kit/Skeleton";
import { useGateways } from "../_hooks/useGateways";
import { canManageLinks } from "../_lib/gateway-form";
import { GatewayFormModal } from "./GatewayFormModal";
import { GatewayLinks } from "./GatewayLinks";

const G = FrontendI18nKeys.common.gateways;

/**
 * The gateways page (F-102-d, D-31).
 *
 * One page for two audiences, and the page decides neither: billing answers a
 * tenant its own gateways and the platform owner every one, and refuses a write
 * outside that. What this view adds on the owner's tenant type is only the
 * links panel — hiding it from a reseller is a courtesy, the refusal is
 * `SettlementService`'s.
 *
 * **Secrets appear as a state, never a value.** Each gateway shows whether its
 * merchant id and secret key are set; there is nothing to reveal and no route
 * that would reveal it.
 */
export function GatewaysView() {
  const { t } = useLocale();
  const errorMessage = useApiErrorMessage();
  const { me } = usePanelSession();
  const owner = canManageLinks(me);
  const { gateways, grants, isLoading, error, reload } = useGateways(owner);

  const [editing, setEditing] = useState<AdminGateway | "new" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const remove = async (g: AdminGateway) => {
    if (!window.confirm(t("common", G.confirmDelete, { name: g.displayName }))) return;
    setActionError(null);
    try {
      const out = await billingApi.deleteGateway(g.source, g.id);
      setNotice(out.mode === "deleted" ? t("common", G.deleted) : t("common", G.deactivated, { count: String(out.grantsWithdrawn) }));
      await reload();
    } catch (e) {
      setActionError(errorMessage(e));
    }
  };

  const secret = (label: string, state: GatewaySecretState | undefined) => (
    <span className="inline-flex items-center gap-1 text-xs text-text-secondary">
      <KeyRound size={12} aria-hidden />
      {label}:{" "}
      <b className={state?.configured ? "text-success" : "text-error"}>
        {state === undefined ? t("common", G.unknown) : state.configured ? t("common", G.configured) : t("common", G.notConfigured)}
      </b>
    </span>
  );

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-bold text-text-primary">
            <Landmark size={18} className="text-primary" aria-hidden />
            {t("common", G.title)}
          </h1>
          <p className="text-xs text-text-secondary">{t("common", G.subtitle)}</p>
        </div>
        <button
          type="button"
          onClick={() => setEditing("new")}
          className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-bold text-white"
        >
          <Plus size={16} aria-hidden />
          {t("common", G.add)}
        </button>
      </header>

      {notice && (
        <p role="status" className="rounded-xl border border-card-border bg-card-bg p-3 text-xs text-text-primary">
          {notice}
        </p>
      )}
      {actionError && (
        <p role="alert" className="text-xs font-bold text-error">
          {actionError}
        </p>
      )}

      <section className="rounded-3xl border border-card-border bg-card-bg p-5 shadow-sm sm:p-6">
        {isLoading ? (
          <div className="grid gap-3" aria-busy="true" aria-label={t("common", G.loading)}>
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : error ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p role="alert" className="text-xs font-bold text-error">
              {errorMessage(error)}
            </p>
            <button type="button" onClick={() => void reload()} className="inline-flex items-center gap-1 text-xs font-bold text-primary">
              <RotateCw size={14} aria-hidden />
              {t("common", G.retry)}
            </button>
          </div>
        ) : gateways.length === 0 ? (
          <p className="text-sm text-text-secondary">{t("common", G.empty)}</p>
        ) : (
          <ul className="divide-y divide-card-border">
            {gateways.map((g) => (
              <li key={`${g.source}:${g.id}`} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-2 text-sm font-bold text-text-primary">
                    {g.displayName}
                    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold text-primary">
                      {g.source === "platform" ? t("common", G.platform) : t("common", G.tenant)}
                    </span>
                    <span className={`text-[10px] font-bold ${g.isActive ? "text-success" : "text-text-secondary"}`}>
                      {g.isActive ? t("common", G.active) : t("common", G.inactive)}
                    </span>
                  </span>
                  <span className="text-xs text-text-secondary" dir="ltr">
                    {g.providerName} · {g.gatewayCategory}
                    {g.verificationStatus ? ` · ${g.verificationStatus}` : ""}
                    {owner && g.tenantId ? ` · ${g.tenantId}` : ""}
                  </span>
                  <span className="flex flex-wrap gap-3">
                    {secret(t("common", G.merchantId), g.credentials?.merchantId)}
                    {secret(t("common", G.secretKey), g.credentials?.secretKey)}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => setEditing(g)} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-bold text-primary">
                    <Pencil size={14} aria-hidden />
                    {t("common", G.edit)}
                  </button>
                  <button type="button" onClick={() => void remove(g)} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-bold text-error">
                    <Trash2 size={14} aria-hidden />
                    {t("common", G.delete)}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {owner && grants && <GatewayLinks gateways={gateways} grants={grants} onChanged={reload} />}

      {editing && (
        <GatewayFormModal
          gateway={editing === "new" ? null : editing}
          me={me}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            setNotice(null);
            await reload();
          }}
        />
      )}
    </div>
  );
}
