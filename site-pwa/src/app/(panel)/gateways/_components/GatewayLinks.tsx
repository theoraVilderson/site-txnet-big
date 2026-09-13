"use client";

import { useState } from "react";
import { Link2, Unlink } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { billingApi, type AdminGateway, type GatewayGrant } from "@/lib/billing-api";
import { Select } from "../../_components/kit/Select";

const L = FrontendI18nKeys.common.gateways.links;

interface GatewayLinksProps {
  gateways: AdminGateway[];
  grants: GatewayGrant[];
  onChanged: () => void | Promise<void>;
}

const key = (g: { source: "platform" | "tenant"; id: string }) => `${g.source}:${g.id}`;

/**
 * Linking a gateway to another tenant (F-102-d over F-096-e, ADR-0041) —
 * rendered for the platform owner only.
 *
 * It is the settlement grant under a plainer name, and it adds no rule: a
 * gateway linked to its own tenant, or linked twice, is refused by
 * `SettlementService` and the refusal's sentence is shown as it arrived.
 * Unlinking withdraws the grant; the row stays, because the payments taken
 * through it still point at it.
 */
export function GatewayLinks({ gateways, grants, onChanged }: GatewayLinksProps) {
  const { t } = useLocale();
  const errorMessage = useApiErrorMessage();
  const [tenantId, setTenantId] = useState("");
  const [gatewayKey, setGatewayKey] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const nameOf = (grant: GatewayGrant) => {
    const g = gateways.find((x) =>
      grant.gatewayId ? x.source === "platform" && x.id === grant.gatewayId : x.source === "tenant" && x.id === grant.tenantGatewayConfigId,
    );
    return g?.displayName ?? grant.gatewayId ?? grant.tenantGatewayConfigId ?? "—";
  };

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setFailure(null);
    try {
      await fn();
      await onChanged();
    } catch (e) {
      setFailure(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const link = () => {
    const g = gateways.find((x) => key(x) === gatewayKey);
    if (!g || !tenantId.trim()) return;
    void run(async () => {
      await billingApi.createGatewayGrant({
        tenantId: tenantId.trim(),
        ...(g.source === "platform" ? { gatewayId: g.id } : { tenantGatewayConfigId: g.id }),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setTenantId("");
      setNote("");
    });
  };

  const input =
    "rounded-xl border border-card-border bg-[var(--bg-inner)] px-3 py-2 text-sm text-[var(--text-input)] placeholder:text-[var(--text-label)] transition-colors hover:border-[var(--accent-primary)] focus:border-[var(--accent-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-glow)]";

  return (
    <section className="rounded-3xl border border-card-border bg-card-bg p-5 shadow-sm sm:p-6">
      <h2 className="flex items-center gap-2 text-sm font-bold text-text-primary">
        <Link2 size={16} className="text-primary" aria-hidden />
        {t("common", L.title)}
      </h2>
      <p className="mb-4 text-xs text-text-secondary">{t("common", L.subtitle)}</p>

      <div className="mb-4 grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
        <input className={input} dir="ltr" placeholder={t("common", L.tenantId)} value={tenantId} onChange={(e) => setTenantId(e.target.value)} />
        <Select
          value={gatewayKey}
          onChange={setGatewayKey}
          ariaLabel={t("common", L.gateway)}
          placeholder={t("common", L.gateway)}
          options={gateways.map((g) => ({
            value: key(g),
            label: `${g.displayName} (${t("common", g.source === "platform" ? FrontendI18nKeys.common.gateways.platform : FrontendI18nKeys.common.gateways.tenant)})`,
          }))}
        />
        <input className={input} placeholder={t("common", L.note)} value={note} onChange={(e) => setNote(e.target.value)} />
        <button
          type="button"
          disabled={busy || !tenantId.trim() || !gatewayKey}
          onClick={link}
          className="rounded-xl bg-primary px-4 py-2 text-sm font-bold text-white disabled:opacity-60"
        >
          {t("common", L.link)}
        </button>
      </div>

      {failure && (
        <p role="alert" className="mb-3 text-xs font-bold text-error">
          {failure}
        </p>
      )}

      {grants.length === 0 ? (
        <p className="text-sm text-text-secondary">{t("common", L.empty)}</p>
      ) : (
        <ul className="divide-y divide-card-border">
          {grants.map((grant) => (
            <li key={grant.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs">
              <span className="text-text-primary">
                <b>{nameOf(grant)}</b> → <span dir="ltr">{grant.tenantId}</span>
                {grant.note ? ` · ${grant.note}` : ""}
              </span>
              {grant.isActive ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(() => billingApi.withdrawGatewayGrant(grant.id))}
                  className="inline-flex items-center gap-1 font-bold text-error disabled:opacity-60"
                >
                  <Unlink size={12} aria-hidden />
                  {t("common", L.unlink)}
                </button>
              ) : (
                <span className="text-text-secondary">{t("common", L.withdrawn)}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
