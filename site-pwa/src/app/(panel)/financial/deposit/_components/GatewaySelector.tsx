"use client";

import { CreditCard, FlaskConical, RotateCw } from "lucide-react";
import { settlesItself } from "@/lib/billing/manual-transfer";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { DepositGateway } from "@/lib/billing-api";
import { Badge, Button } from "../../../_components/kit";
import { transferKind } from "../../../_components/transfer/transfer-kinds";
import { Skeleton } from "../../../_components/kit/Skeleton";
import { formatMoney } from "../../../_lib/money";
import { groupGateways } from "../_lib/gateway-groups";

const D = FrontendI18nKeys.common.deposit.gateway;

interface GatewaySelectorProps {
  gateways: DepositGateway[];
  /** The pair identifies a row: an id alone can belong to either table (D-25). */
  selected: DepositGateway | null;
  onSelect: (gateway: DepositGateway) => void;
  isLoading: boolean;
  /** The list did not load. Translated where there was server text, else the panel's own line. */
  error: string | null;
  onRetry: () => void;
}

/** `source:id` — the only thing that identifies a gateway across the two tables. */
export const gatewayKey = (g: DepositGateway) => `${g.source}:${g.id}`;

/**
 * The gateway picker (F-093-e).
 *
 * **Every gateway in this list is usable.** `GET /deposit/gateways` leaves out
 * anything without a driver, without a verified config or without a merchant
 * id in the vault (`billing/contract.deposit.md`), so there is no disabled
 * state to render and no "why can't I pick this" to explain. Legacy filtered a
 * hard-coded `GATEWAYS` array against what the server sent and rendered the
 * intersection — a gateway the tenant had just added showed up nowhere until
 * the app was rebuilt.
 *
 * The logo is the first letter of the display name. Legacy carried a colour and
 * a glyph per provider in a constant; a provider added server-side would have
 * had neither. A manual gateway shows its kind's icon instead (F-803-h).
 *
 * Gateways that settle themselves come first under their own heading, then the
 * ones a person confirms (`groupGateways`), and a manual gateway says which it
 * is: `info` "confirmed by a person", or `success` "confirmed automatically"
 * once a watcher exists (F-803-f).
 */
export function GatewaySelector({
  gateways,
  selected,
  onSelect,
  isLoading,
  error,
  onRetry,
}: GatewaySelectorProps) {
  const { lang, t } = useLocale();
  const money = (value: string, currency: string) => formatMoney(value, currency, { lang, t });
  const groups = groupGateways(gateways);
  const rangeText = (gateway: DepositGateway) =>
    gateway.minAmount && gateway.maxAmount
      ? t("common", D.range, { min: money(gateway.minAmount, gateway.currencyCode), max: money(gateway.maxAmount, gateway.currencyCode) })
      : gateway.minAmount
        ? t("common", D.rangeFrom, { min: money(gateway.minAmount, gateway.currencyCode) })
        : gateway.maxAmount
          ? t("common", D.rangeUpTo, { max: money(gateway.maxAmount, gateway.currencyCode) })
          : t("common", D.rangeAny);

  return (
    <section className="rounded-3xl border border-card-border bg-card-bg p-5 shadow-sm sm:p-6">
      <h2 className="mb-4 flex items-center gap-2 text-sm font-bold text-text-primary">
        <CreditCard size={16} className="text-primary" aria-hidden />
        {t("common", D.label)}
      </h2>

      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2" aria-busy="true" aria-label={t("common", D.loading)}>
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : error ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p role="alert" className="text-xs font-bold text-error">
            {error}
          </p>
          <Button size="sm" icon={<RotateCw size={12} aria-hidden />} onClick={onRetry}>
            {t("common", D.retry)}
          </Button>
        </div>
      ) : gateways.length === 0 ? (
        <p className="text-xs font-bold text-text-secondary">{t("common", D.empty)}</p>
      ) : (
        <div role="radiogroup" aria-label={t("common", D.label)} className="flex flex-col gap-4">
          {groups.map((group) => (
            <div key={group.id} role="group" aria-labelledby={`gateway-group-${group.id}`} className="flex flex-col gap-2">
              {/* One group needs no heading: there is nothing to tell it apart from. */}
              <h3 id={`gateway-group-${group.id}`} className={groups.length > 1 ? "text-2xs font-bold text-text-secondary" : "sr-only"}>
                {t("common", D.groups[group.id])}
              </h3>
              <div className="grid gap-3 sm:grid-cols-2">
                {group.gateways.map((gateway) => (
                  <GatewayTile
                    key={gatewayKey(gateway)}
                    gateway={gateway}
                    isSelected={selected !== null && gatewayKey(selected) === gatewayKey(gateway)}
                    onSelect={() => onSelect(gateway)}
                    rangeText={rangeText(gateway)}
                  />
                ))}
              </div>
            </div>
          ))}
          {selected?.testing && (
            <p className="flex items-start gap-2 rounded-xl border border-dashed border-primary bg-leaf-bg p-3 text-2xs leading-5 text-text-primary">
              <FlaskConical size={14} className="mt-0.5 shrink-0 text-primary" aria-hidden />
              {t("common", D.testingHint)}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

interface GatewayTileProps {
  gateway: DepositGateway;
  isSelected: boolean;
  onSelect: () => void;
  rangeText: string;
}

/** One gateway's radio tile: its logo or kind icon, name, test and mode badges, and its range. */
function GatewayTile({ gateway, isSelected, onSelect, rangeText }: GatewayTileProps) {
  const { t } = useLocale();
  const Icon = gateway.manualKind ? transferKind(gateway.manualKind).icon : null;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={isSelected}
      onClick={onSelect}
      className={`flex items-center gap-3 rounded-2xl border p-3 text-start transition-colors ${
        isSelected ? "border-primary bg-leaf-bg" : "border-card-border bg-bg-inner hover:border-text-secondary"
      }`}
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-base font-bold text-on-accent">
        {Icon ? <Icon size={18} aria-hidden /> : gateway.displayName.slice(0, 1).toUpperCase()}
      </span>
      <span className="min-w-0">
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="truncate text-sm font-bold text-text-primary">{gateway.displayName}</span>
          {gateway.testing && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-dashed border-primary px-1.5 py-0.5 text-3xs font-bold text-primary">
              <FlaskConical size={10} aria-hidden />
              {t("common", D.testing)}
            </span>
          )}
          {gateway.manualKind && (
            <Badge tone={settlesItself(gateway) ? "success" : "info"} className="px-1.5 text-3xs">
              {t("common", settlesItself(gateway) ? D.confirmedAutomatically : D.byPerson)}
            </Badge>
          )}
        </span>
        <span dir="ltr" className="block truncate text-2xs text-text-secondary">
          {rangeText}
        </span>
      </span>
    </button>
  );
}
