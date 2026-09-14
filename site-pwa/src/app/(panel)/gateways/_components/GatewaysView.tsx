"use client";

import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { KeyRound, Landmark, Loader2, Pencil, Plus, RotateCw, Trash2 } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { billingApi, type AdminGateway, type GatewaySecretState } from "@/lib/billing-api";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { Skeleton } from "../../_components/kit/Skeleton";
import { useGateways } from "../_hooks/useGateways";
import { canManageLinks } from "../_lib/gateway-form";
import { GatewayFormModal } from "./GatewayFormModal";
import { DepositPresetsCard } from "./DepositPresetsCard";
import { GatewayLinks } from "./GatewayLinks";
import { GatewayWizard } from "./GatewayWizard";

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
  const { me, isLoading: sessionLoading } = usePanelSession();
  const owner = canManageLinks(me);
  const { gateways, grants, presets, isLoading, isRefreshing, error, reload } = useGateways(owner, !sessionLoading);
  const reduceMotion = useReducedMotion();
  // One moment for the whole page: the list and the links panel appear together,
  // never the list first and the owner's panel a beat later.
  const ready = !sessionLoading && !isLoading;
  const reveal = (i: number) =>
    reduceMotion
      ? {}
      : {
          initial: { opacity: 0, y: 12 },
          animate: { opacity: 1, y: 0 },
          transition: {
            duration: 0.28,
            delay: i * 0.07,
            ease: "easeOut" as const,
          },
        };

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
          disabled={!ready}
          onClick={() => setEditing("new")}
          className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-bold text-white shadow-sm transition-all hover:brightness-110 disabled:opacity-50"
        >
          <Plus size={16} aria-hidden />
          {t("common", G.add)}
        </button>
      </header>

      <AnimatePresence initial={false}>
        {notice && (
          <motion.p
            key="notice"
            role="status"
            {...reveal(0)}
            exit={reduceMotion ? undefined : { opacity: 0 }}
            className="rounded-xl border border-card-border bg-card-bg p-3 text-xs text-text-primary"
          >
            {notice}
          </motion.p>
        )}
      </AnimatePresence>
      {actionError && (
        <p role="alert" className="text-xs font-bold text-error">
          {actionError}
        </p>
      )}

      {!ready ? (
        <GatewaysSkeleton withLinks={owner} label={t("common", G.loading)} />
      ) : (
        <>
          <motion.section
            {...reveal(0)}
            aria-busy={isRefreshing}
            className="relative rounded-3xl border border-card-border bg-card-bg p-5 shadow-sm sm:p-6"
          >
            {isRefreshing && <Loader2 size={16} className="absolute end-4 top-4 animate-spin text-primary" aria-label={t("common", G.loading)} />}
            <div className={`transition-opacity duration-200 ${isRefreshing ? "opacity-60" : "opacity-100"}`}>
              {error ? (
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
                <div className="flex flex-col items-center gap-3 py-6 text-center">
                  <span className="grid size-14 place-items-center rounded-2xl bg-[var(--leaf-bg)] text-primary">
                    <Landmark size={26} aria-hidden />
                  </span>
                  <p className="text-sm text-text-secondary">{t("common", G.empty)}</p>
                  <button
                    type="button"
                    onClick={() => setEditing("new")}
                    className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-bold text-white shadow-md"
                  >
                    <Plus size={16} aria-hidden />
                    {t("common", G.add)}
                  </button>
                </div>
              ) : (
                <ul className="divide-y divide-card-border">
                  {gateways.map((g, i) => (
                    <motion.li
                      key={`${g.source}:${g.id}`}
                      {...(reduceMotion
                        ? {}
                        : {
                            initial: { opacity: 0 },
                            animate: { opacity: 1 },
                            transition: {
                              duration: 0.2,
                              delay: 0.1 + Math.min(i, 8) * 0.04,
                            },
                          })}
                      className="flex flex-wrap items-center justify-between gap-3 py-3"
                    >
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
                        <button
                          type="button"
                          onClick={() => setEditing(g)}
                          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-bold text-primary"
                        >
                          <Pencil size={14} aria-hidden />
                          {t("common", G.edit)}
                        </button>
                        <button
                          type="button"
                          onClick={() => void remove(g)}
                          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-bold text-error"
                        >
                          <Trash2 size={14} aria-hidden />
                          {t("common", G.delete)}
                        </button>
                      </div>
                    </motion.li>
                  ))}
                </ul>
              )}
            </div>
          </motion.section>

          {presets && (
            <motion.div {...reveal(1)}>
              <DepositPresetsCard initial={presets} />
            </motion.div>
          )}

          {owner && grants && (
            <motion.div {...reveal(2)}>
              <GatewayLinks gateways={gateways} grants={grants} onChanged={reload} />
            </motion.div>
          )}
        </>
      )}

      {editing === "new" && (
        <GatewayWizard
          me={me}
          onClose={() => setEditing(null)}
          onCreated={async () => {
            setNotice(null);
            await reload();
          }}
        />
      )}
      {editing && editing !== "new" && (
        <GatewayFormModal
          gateway={editing}
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

/** The page's final shape while it loads, so nothing moves when the data arrives. */
function GatewaysSkeleton({ withLinks, label }: { withLinks: boolean; label: string }) {
  const row = (i: number) => (
    <div key={i} className="flex items-center justify-between gap-3 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <Skeleton className="h-4 w-40 max-w-full" />
        <Skeleton className="h-3 w-56 max-w-full" />
        <Skeleton className="h-3 w-64 max-w-full" />
      </div>
      <div className="flex gap-2">
        <Skeleton className="h-7 w-16" />
        <Skeleton className="h-7 w-14" />
      </div>
    </div>
  );
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label={label}>
      <div className="divide-y divide-card-border rounded-3xl border border-card-border bg-card-bg p-5 shadow-sm sm:p-6">{[0, 1, 2].map(row)}</div>
      <div className="flex flex-col gap-3 rounded-3xl border border-card-border bg-card-bg p-5 shadow-sm sm:p-6">
        <div className="flex items-center gap-3">
          <Skeleton className="size-10" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-64 max-w-full" />
          </div>
        </div>
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
      {withLinks && (
        <div className="flex flex-col gap-3 rounded-3xl border border-card-border bg-card-bg p-5 shadow-sm sm:p-6">
          <Skeleton className="h-4 w-44" />
          <Skeleton className="h-3 w-72 max-w-full" />
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
            <Skeleton className="h-9" />
            <Skeleton className="h-9" />
            <Skeleton className="h-9" />
            <Skeleton className="h-9 w-16" />
          </div>
          <Skeleton className="h-8 w-full" />
        </div>
      )}
    </div>
  );
}
