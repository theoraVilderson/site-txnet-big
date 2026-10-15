"use client";

import type { ReactNode } from "react";
import { Check, type LucideIcon } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { TRANSFER_KINDS } from "../../_components/transfer/transfer-kinds";
import type { TransferKind } from "../../_components/transfer/transfer-kind";
import { CATEGORIES, PROVIDERS, emptyForm, type FormError, type GatewayForm } from "../_lib/gateway-form";
import { applyKind, applyProvider, type Provider } from "../_lib/gateway-wizard";
import { PROVIDER_ICONS, fieldErrorText } from "./gateway-fields";

const G = FrontendI18nKeys.common.gateways;
const W = G.wizard;
const M = G.manual;

/** A kind's name and sentence, in the page's language. */
export function useKindText(): (kind: string) => { title: string; desc: string } {
  const { t } = useLocale();
  const K = FrontendI18nKeys.common.transfer.kinds;
  return (kind) =>
    kind in K
      ? { title: t("common", K[kind as keyof typeof K].title), desc: t("common", K[kind as keyof typeof K].desc) }
      : { title: kind, desc: "" };
}

interface PickerCardProps {
  selected: boolean;
  icon: LucideIcon;
  title: ReactNode;
  subtitle: string;
  desc: string;
  onPick: () => void;
}

function PickerCard({ selected, icon: Icon, title, subtitle, desc, onPick }: PickerCardProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onPick}
      className={`group relative flex flex-col gap-3 rounded-2xl border p-4 text-start transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-glow)] ${
        selected
          ? "border-[var(--accent-primary)] bg-[var(--leaf-bg)] shadow-md"
          : "border-card-border bg-[var(--bg-inner)] hover:-translate-y-0.5 hover:border-[var(--accent-primary)] hover:shadow-sm"
      }`}
    >
      <span className="flex items-center gap-3">
        <span className={`grid size-10 place-items-center rounded-xl transition-colors ${selected ? "bg-primary text-on-accent" : "bg-card-bg text-primary"}`}>
          <Icon size={20} aria-hidden />
        </span>
        <span className="flex flex-col">
          <span className="text-sm font-bold text-text-primary">{title}</span>
          <span className="text-2xs text-text-secondary">{subtitle}</span>
        </span>
      </span>
      <span className="text-xs leading-5 text-text-secondary">{desc}</span>
      {selected && (
        <span className="absolute end-3 top-3 grid size-6 place-items-center rounded-full bg-primary text-on-accent">
          <Check size={14} aria-hidden />
        </span>
      )}
    </button>
  );
}

/**
 * The wizard's first choice (F-102-e, F-803-g): an online gateway by its
 * provider, or a manual method by its kind — a card-to-card or a wallet — each
 * a card with an icon and one sentence. Picking one answers the next form;
 * the rules of what a pick implies are `applyProvider` / `applyKind`.
 */
export function WizardProviderPicker({ form, error, onPick }: { form: GatewayForm; error?: FormError; onPick: (next: GatewayForm) => void }) {
  const { t } = useLocale();
  const kindText = useKindText();
  const providerDefaults = (p: Provider) => applyProvider(emptyForm("tenant"), p);
  const pickKind = (kind: TransferKind) =>
    onPick(applyKind(form, kind, { suggested: kindText(kind.kind).title, previous: form.manualKind ? kindText(form.manualKind).title : null }));

  const group = (title: string, hint: string, cards: ReactNode) => (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-bold text-text-primary">{title}</h3>
      <p className="-mt-1 text-2xs text-text-secondary">{hint}</p>
      <div role="radiogroup" aria-label={title} className="grid gap-3 sm:grid-cols-2">
        {cards}
      </div>
    </section>
  );

  return (
    <div className="flex flex-col gap-5">
      {group(
        t("common", M.automaticGroup),
        t("common", M.automaticGroupHint),
        PROVIDERS.map((p) => (
          <PickerCard
            key={p}
            selected={form.providerName === p}
            icon={PROVIDER_ICONS[p]}
            title={<span dir="ltr">{providerDefaults(p).displayName}</span>}
            subtitle={t("common", W.categories[providerDefaults(p).gatewayCategory as (typeof CATEGORIES)[number]])}
            desc={t("common", W.providers[p].desc)}
            onPick={() => onPick(applyProvider(form, p))}
          />
        )),
      )}
      {group(
        t("common", M.manualGroup),
        t("common", M.manualGroupHint),
        TRANSFER_KINDS.map((k) => (
          <PickerCard
            key={k.kind}
            selected={form.manualKind === k.kind}
            icon={k.icon}
            title={kindText(k.kind).title}
            subtitle={t("common", M.byPersonShort)}
            desc={kindText(k.kind).desc}
            onPick={() => pickKind(k)}
          />
        )),
      )}
      {error && (
        <span role="alert" className="text-2xs font-bold text-error">
          {fieldErrorText(t, error)}
        </span>
      )}
    </div>
  );
}
