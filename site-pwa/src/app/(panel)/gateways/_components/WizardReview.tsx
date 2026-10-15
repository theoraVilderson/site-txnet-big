"use client";

import { motion, useReducedMotionConfig } from "framer-motion";
import { Building2, Check, KeyRound, Landmark, ListChecks, Percent, Plus, TriangleAlert, type LucideIcon } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { isManualProvider } from "@/lib/billing/manual-transfer";
import { Button, ReviewRows, type ReviewRow } from "../../_components/kit";
import { CATEGORIES, emptyForm, type GatewayForm } from "../_lib/gateway-form";
import { applyProvider, type Provider, type WizardStepId } from "../_lib/gateway-wizard";
import { providerFields, secretFields } from "../_lib/provider-fields";
import { useRangeText } from "./gateway-fields";
import { useKindText } from "./WizardProviderPicker";

const G = FrontendI18nKeys.common.gateways;
const F = G.form;
const W = G.wizard;
const M = G.manual;
const T = FrontendI18nKeys.common.transfer;

export const STEP_ICONS: Record<WizardStepId, LucideIcon> = {
  provider: Landmark,
  details: Building2,
  fee: Percent,
  secrets: KeyRound,
  review: ListChecks,
};

/** The keys step's rows: a provider's secrets as entered-or-not and its callback, a manual kind's proof and window. */
function useConnectionRows(form: GatewayForm): ReviewRow[] {
  const { t } = useLocale();
  if (isManualProvider(form.providerName)) {
    const proof = form.requiredProof.map((id) => (id in T.proof ? t("common", T.proof[id as keyof typeof T.proof]) : id));
    return [
      [t("common", M.requiredProof), proof.join(" · ")],
      [t("common", M.windowMinutes), `${form.windowMinutes.trim()} ${t("common", M.minutes)}`],
      [t("common", M.confirmWithinMinutes), form.confirmWithinMinutes.trim() ? `${form.confirmWithinMinutes.trim()} ${t("common", M.minutes)}` : t("common", M.confirmWithinNone)],
    ];
  }
  const secretState = (v: string) =>
    v.trim() ? (
      <span className="inline-flex items-center gap-1 text-success">
        <Check size={12} aria-hidden />
        {t("common", W.secrets.entered)}
      </span>
    ) : (
      <span className="text-text-secondary">{t("common", W.secrets.notEntered)}</span>
    );
  return [
    ...providerFields(form.providerName).map((f): ReviewRow => [
      t("common", G.fields[f.label]),
      f.slot === "staticRate" ? <span dir="ltr">{form.staticRate.trim()} USD</span> : secretState(form[f.slot]),
    ]),
    [
      t("common", G.callback.label),
      form.callbackUrl.trim() ? (
        <span dir="ltr" className="break-all">
          {form.callbackUrl.trim()}
        </span>
      ) : (
        t("common", G.callback.default)
      ),
    ],
  ];
}

/** The wizard's last step: every choice by step, each with a way back to it. */
export function ReviewStep({ form, owner, money, onEdit }: { form: GatewayForm; owner: boolean; money: (a: string) => string; onEdit: (id: WizardStepId) => void }) {
  const { t } = useLocale();
  const rangeText = useRangeText(money);
  const kindText = useKindText();
  const connectionRows = useConnectionRows(form);
  const none = t("common", W.review.none);
  const manual = isManualProvider(form.providerName);
  const category = form.gatewayCategory as (typeof CATEGORIES)[number];
  // A heads-up, not a block: the gateway saves and may go live without its keys (F-104-e).
  const missingSecrets = secretFields(form.providerName).some((f) => !form[f.slot].trim());

  const section = (id: WizardStepId, rows: ReviewRow[]) => {
    const Icon = STEP_ICONS[id];
    return (
      <section className="rounded-2xl border border-card-border bg-[var(--bg-inner)] p-4">
        <ReviewRows icon={Icon} title={t("common", id === "secrets" && manual ? M.proofStep.title : W.steps[id].title)} editLabel={t("common", W.edit)} onEdit={() => onEdit(id)} rows={rows} />
      </section>
    );
  };

  const providerText = manual
    ? kindText(form.manualKind).title
    : form.providerName
      ? <span dir="ltr">{applyProvider(emptyForm("tenant"), form.providerName as Provider).displayName}</span>
      : none;
  const feeText =
    form.feeCalculationMode === "automatic"
      ? t("common", W.feeModes.automatic.title)
      : form.feeType === "percentage"
        ? <span dir="ltr">{form.feeValue}%</span>
        : <span dir="ltr">{money(form.feeValue)}</span>;
  const ownerText = form.source === "platform" ? t("common", W.owner.platform) : form.tenantId.trim() ? <span dir="ltr">{form.tenantId}</span> : t("common", W.owner.tenant);

  return (
    <div className="flex flex-col gap-3">
      {section("provider", [...(owner ? ([[t("common", W.review.owner), ownerText]] as ReviewRow[]) : []), [t("common", F.provider), providerText]])}
      {section("details", [
        [t("common", F.displayName), form.displayName || none],
        ...(manual ? [] : ([[t("common", F.category), category ? t("common", W.categories[category]) : none]] as ReviewRow[])),
        [t("common", W.review.range), <span key="r" dir="ltr">{rangeText(form.minAcceptAmount, form.maxAcceptAmount)}</span>],
        [t("common", F.isActive), form.isActive ? t("common", W.review.yes) : t("common", W.review.no)],
        [
          t("common", G.presets.title),
          form.depositPresets.length > 0 ? <span dir="ltr">{form.depositPresets.map((p) => money(p)).join(" · ")}</span> : t("common", G.presets.inherit),
        ],
      ])}
      {section("fee", [
        [t("common", F.feeValue), feeText],
        [t("common", W.review.floor), form.feeFloor ? <span dir="ltr">{money(form.feeFloor)}</span> : none],
        [t("common", W.review.ceiling), form.feeCeiling ? <span dir="ltr">{money(form.feeCeiling)}</span> : none],
        [t("common", G.tax.label), form.taxRatePercent.trim() ? <span dir="ltr">{form.taxRatePercent.trim()}%</span> : t("common", G.tax.inherit)],
      ])}
      {section("secrets", connectionRows)}
      {missingSecrets && (
        <p className="flex items-start gap-2 rounded-xl border border-[var(--error-border)] bg-[var(--error-bg)] p-3 text-xs text-text-primary">
          <TriangleAlert size={14} className="mt-0.5 shrink-0 text-error" aria-hidden />
          {t("common", W.secrets.missing)}
        </p>
      )}
    </div>
  );
}

interface DoneScreenProps {
  name: string;
  onAnother: () => void;
  onFinish: () => void;
  /** A manual gateway is offered only with an active card or wallet (F-803-c): the next thing to do, one press away. */
  onAddDestination?: () => void;
}

/** After a create: what to do next, and the way to it. */
export function DoneScreen({ name, onAnother, onFinish, onAddDestination }: DoneScreenProps) {
  const { t } = useLocale();
  const reduceMotion = useReducedMotionConfig();
  return (
    <div className="flex flex-col items-center gap-5 py-6 text-center">
      <motion.span
        initial={reduceMotion ? false : { scale: 0.4, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 260, damping: 18 }}
        className="grid size-20 place-items-center rounded-full bg-[image:var(--card-gradient)] text-white shadow-lg"
      >
        <Check size={40} strokeWidth={3} aria-hidden />
      </motion.span>
      <div>
        <h3 className="text-lg font-bold text-text-primary">{t("common", W.done.title, { name })}</h3>
        <p className="mt-1 text-xs text-text-secondary">{t("common", onAddDestination ? M.done.subtitle : W.done.subtitle)}</p>
      </div>
      {onAddDestination ? (
        <Button variant="primary" size="lg" onClick={onAddDestination} icon={<Plus size={16} aria-hidden />}>
          {t("common", M.done.addDestination)}
        </Button>
      ) : (
        <ol className="flex w-full max-w-md flex-col gap-2 text-start">
          {[W.done.step1, W.done.step2, W.done.step3].map((k, i) => (
            <li key={k} className="flex items-center gap-3 rounded-xl border border-card-border bg-[var(--bg-inner)] p-3 text-xs text-text-primary">
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-[var(--leaf-bg)] text-2xs font-bold text-primary">{i + 1}</span>
              {t("common", k)}
            </li>
          ))}
        </ol>
      )}
      <div className="flex w-full max-w-md flex-col-reverse gap-2 sm:flex-row">
        <Button onClick={onAnother} className="flex-1">
          {t("common", W.done.another)}
        </Button>
        <Button variant={onAddDestination ? "secondary" : "primary"} onClick={onFinish} className="flex-1">
          {t("common", W.done.finish)}
        </Button>
      </div>
    </div>
  );
}
