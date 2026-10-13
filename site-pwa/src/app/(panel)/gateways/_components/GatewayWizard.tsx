"use client";

import { Fragment, useState, type ReactNode } from "react";
import { motion, useReducedMotionConfig } from "framer-motion";
import { Building2, Check, Globe, KeyRound, Landmark, ListChecks, Percent, ShieldCheck, TriangleAlert, type LucideIcon } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useGatewayMessage, type GatewaySurface } from "../_lib/surface";
import type { Me } from "@/lib/auth-api";
import type { GatewaySecretName } from "@/lib/billing-api";
import { Select } from "../../_components/kit/Select";
import { PresetsEditor } from "./PresetsEditor";
import { formatMoney } from "../../_lib/money";
import {
  CATEGORIES,
  PROVIDERS,
  createBody,
  emptyForm,
  type FormErrors,
  type GatewayForm,
} from "../_lib/gateway-form";
import {
  WIZARD_STEPS,
  applyProvider,
  firstInvalidStep,
  stepErrors,
  type Provider,
  type WizardStepId,
} from "../_lib/gateway-wizard";
import { providerFields, secretFields } from "../_lib/provider-fields";
import { ChoiceCards, FeeFields, Field, PROVIDER_ICONS, SecretInput, fieldErrorText, useRangeText } from "./gateway-fields";
import { Toggle } from "../../_components/kit/Toggle";
import { Wizard, useWizard } from "../../_components/kit/Wizard";
import { Button, Input } from "../../_components/kit";
import { isPlatformTenant } from "@/lib/tenant-type";

const G = FrontendI18nKeys.common.gateways;
const F = G.form;
const W = G.wizard;

const STEP_ICONS: Record<WizardStepId, LucideIcon> = {
  provider: Landmark,
  details: Building2,
  fee: Percent,
  secrets: KeyRound,
  review: ListChecks,
};


interface GatewayWizardProps {
  surface: GatewaySurface;
  me: Me | null;
  /**
   * What a new gateway's amounts will be in: the surface tenant's currency now
   * (F-116-h3), as the presets answer names it; `null` when that was not read —
   * then amounts are shown bare rather than in a currency guessed.
   */
  currency: string | null;
  onClose: () => void;
  /** A gateway was created. The page re-reads its list; the wizard stays open on its done screen. */
  onCreated: () => void | Promise<void>;
}

/**
 * Add a gateway, one concern per step (F-102-e): provider → details → fee →
 * keys → review. Editing is `GatewayEditor`; both build the same
 * {@link GatewayForm} from the controls in `gateway-fields.tsx`, and the wizard
 * sends it through `createBody`, so it adds no rule of its own.
 *
 * A full-screen sheet below `sm`, a dialog above it with the step list at the
 * side on `lg`. Secrets are write-only exactly as in the editor: the review step
 * says whether one was entered, never what it is.
 */
export function GatewayWizard({ surface, me, currency, onClose, onCreated }: GatewayWizardProps) {
  const { t, lang } = useLocale();
  const errorMessage = useGatewayMessage(surface);
  const owner = isPlatformTenant(me?.tenant?.type);

  const initialForm = () => emptyForm(owner ? "platform" : "tenant");
  const [form, setForm] = useState<GatewayForm>(initialForm);
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const wizard = useWizard({
    count: WIZARD_STEPS.length,
    validate: (i) => {
      const found = stepErrors(form, WIZARD_STEPS[i].id);
      setErrors(found);
      return Object.keys(found).length === 0;
    },
    onMove: () => setFailure(null),
  });

  const step = WIZARD_STEPS[wizard.index];
  const code = currency ?? "";
  const money = (amount: string) => (code ? formatMoney(amount, code, { lang, t }) : amount);
  const goTo = (id: WizardStepId) => wizard.goTo(WIZARD_STEPS.findIndex((s) => s.id === id));

  const set = <K extends keyof GatewayForm>(k: K, v: GatewayForm[K]) => {
    setTouched(true);
    setForm((f) => ({ ...f, [k]: v }));
    if (errors[k]) setErrors((e) => ({ ...e, [k]: undefined }));
  };

  const submit = async () => {
    const bad = firstInvalidStep(form);
    if (bad) {
      setErrors(stepErrors(form, bad));
      goTo(bad);
      return;
    }
    setSaving(true);
    setFailure(null);
    try {
      await surface.api.create(createBody(form, me));
      setCreated(form.displayName.trim());
      await onCreated();
    } catch (e) {
      setFailure(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const restart = () => {
    setForm(initialForm());
    setErrors({});
    setCreated(null);
    setTouched(false);
    wizard.reset();
  };

  const errorText = (k: keyof GatewayForm) =>
    errors[k] ? (
      <span role="alert" className="text-2xs font-bold text-error">
        {fieldErrorText(t, errors[k]!)}
      </span>
    ) : null;

  const labeled = (k: keyof GatewayForm, label: string, control: ReactNode, hint?: string, optional = false) => (
    <Field id={`gw-${k}`} label={label} error={errors[k]} hint={hint} optional={optional}>
      {control}
    </Field>
  );

  // The wrapper carries the input's direction: with only the input `ltr`, its
  // `pe-*` pads the right while the suffix's `end-*` sits left in RTL, on the text.
  const textInput = (k: keyof GatewayForm, opts: { ltr?: boolean; suffix?: string; placeholder?: string; decimal?: boolean } = {}) => (
    <div dir={opts.ltr ? "ltr" : undefined}>
      <Input
        id={`gw-${k}`}
        inputMode={opts.decimal ? "decimal" : undefined}
        placeholder={opts.placeholder}
        aria-invalid={Boolean(errors[k])}
        value={String(form[k])}
        onChange={(e) => set(k, e.target.value as never)}
        onKeyDown={(e) => {
          if (e.key === "Enter") wizard.next();
        }}
        end={opts.suffix ? <span className="pointer-events-none pe-1.5 text-xs font-bold text-text-secondary">{opts.suffix}</span> : undefined}
      />
    </div>
  );

  /** Two or three mutually exclusive choices, as cards: every option visible, no list to open. */
  const choice = <V extends string>(
    name: string,
    value: string,
    options: readonly { value: V; title: string; desc?: string; icon?: LucideIcon }[],
    onPick: (v: V) => void,
  ) => <ChoiceCards name={name} value={value} options={options} onPick={onPick} />;

  const secretInput = (k: GatewaySecretName) => <SecretInput id={`gw-${k}`} value={form[k]} onChange={(v) => set(k, v)} showLabel={t("common", W.secrets.show)} hideLabel={t("common", W.secrets.hide)} />;

  const provider = form.providerName as Provider | "";

  const steps: Record<WizardStepId, ReactNode> = {
    provider: (
      <div className="flex flex-col gap-5">
        {owner && (
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-bold text-text-primary">{t("common", W.owner.label)}</h3>
            {choice(
              t("common", W.owner.label),
              form.source,
              [
                { value: "tenant", title: t("common", W.owner.tenant), desc: t("common", W.owner.tenantDesc), icon: Building2 },
                { value: "platform", title: t("common", W.owner.platform), desc: t("common", W.owner.platformDesc), icon: Globe },
              ] as const,
              (v) => set("source", v),
            )}
            {form.source === "tenant" &&
              labeled("tenantId", t("common", G.links.tenantId), textInput("tenantId", { ltr: true }), t("common", W.hints.tenantId), true)}
          </section>
        )}
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-bold text-text-primary">{t("common", F.provider)}</h3>
          <div role="radiogroup" aria-label={t("common", F.provider)} className="grid gap-3 sm:grid-cols-2">
            {PROVIDERS.map((p) => {
              const Icon = PROVIDER_ICONS[p];
              const selected = provider === p;
              return (
                <button
                  key={p}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => {
                    setTouched(true);
                    setForm((f) => applyProvider(f, p));
                    setErrors({});
                  }}
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
                      <span className="text-sm font-bold text-text-primary" dir="ltr">
                        {applyProvider(emptyForm("tenant"), p).displayName}
                      </span>
                      <span className="text-2xs text-text-secondary">{t("common", W.categories[applyProvider(emptyForm("tenant"), p).gatewayCategory as (typeof CATEGORIES)[number]])}</span>
                    </span>
                  </span>
                  <span className="text-xs leading-5 text-text-secondary">{t("common", W.providers[p].desc)}</span>
                  {selected && (
                    <span className="absolute end-3 top-3 grid size-6 place-items-center rounded-full bg-primary text-on-accent">
                      <Check size={14} aria-hidden />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {errorText("providerName")}
        </section>
      </div>
    ),

    details: (
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          {labeled("displayName", t("common", F.displayName), textInput("displayName", { placeholder: t("common", W.hints.displayName) }))}
        </div>
        <div className="sm:col-span-2">
          {labeled(
            "gatewayCategory",
            t("common", F.category),
            <Select
              value={form.gatewayCategory}
              onChange={(v) => set("gatewayCategory", v)}
              ariaLabel={t("common", F.category)}
              invalid={Boolean(errors.gatewayCategory)}
              options={CATEGORIES.map((c) => ({ value: c, label: t("common", W.categories[c]) }))}
            />,
          )}
        </div>
        {labeled("minAcceptAmount", t("common", F.minAmount), textInput("minAcceptAmount", { ltr: true, decimal: true, suffix: code, placeholder: t("common", G.range.noLimit) }), undefined, true)}
        {labeled("maxAcceptAmount", t("common", F.maxAmount), textInput("maxAcceptAmount", { ltr: true, decimal: true, suffix: code, placeholder: t("common", G.range.noLimit) }), undefined, true)}
        <p className="-mt-2 text-2xs text-text-secondary sm:col-span-2">{t("common", W.hints.amounts)}</p>
        <div className="sm:col-span-2">
          <Toggle
            checked={form.isActive}
            onChange={(v) => set("isActive", v)}
            label={t("common", F.isActive)}
            hint={t("common", W.hints.isActive)}
          />
        </div>
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <label htmlFor="gw-depositPresets" className="flex items-center gap-2 text-xs font-bold text-text-primary">
            {t("common", FrontendI18nKeys.common.gateways.presets.title)}
            <span className="font-normal text-text-secondary">({t("common", W.optional)})</span>
          </label>
          <p className="text-2xs leading-5 text-text-secondary">{t("common", FrontendI18nKeys.common.gateways.presets.gatewayHint)}</p>
          <PresetsEditor
            id="gw-depositPresets"
            currency={code}
            value={form.depositPresets}
            onChange={(next) => set("depositPresets", next)}
            emptyText={t("common", FrontendI18nKeys.common.gateways.presets.inherit)}
          />
        </div>
      </div>
    ),

    fee: <FeeFields form={form} set={set} errors={errors} money={money} currency={code} />,

    secrets: (
      <div className="flex flex-col gap-4">
        {provider && (
          <div className="flex items-start gap-3 rounded-2xl border border-card-border bg-[var(--bg-inner)] p-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-card-bg text-primary">
              {(() => {
                const Icon = PROVIDER_ICONS[provider];
                return <Icon size={16} aria-hidden />;
              })()}
            </span>
            <p className="text-xs leading-6 text-text-primary">{t("common", W.providers[provider].where)}</p>
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          {/* The chosen provider's own fields, from the one map (F-104-f). */}
          {providerFields(provider).map((f) =>
            f.slot === "staticRate" ? (
              <div key={f.slot} className="sm:col-span-2">
                {labeled("staticRate", t("common", G.fields[f.label]), textInput("staticRate", { ltr: true, decimal: true, suffix: "USD" }), t("common", G.fields.starRateHint))}
              </div>
            ) : (
              <Fragment key={f.slot}>{labeled(f.slot, t("common", G.fields[f.label]), secretInput(f.slot), undefined, true)}</Fragment>
            ),
          )}
        </div>
        {secretFields(provider).length > 0 && (
          <p className="flex items-center gap-1.5 text-2xs font-bold text-success">
            <ShieldCheck size={14} aria-hidden />
            {t("common", W.secrets.safe)}
          </p>
        )}
        {labeled(
          "callbackUrl",
          t("common", G.callback.label),
          textInput("callbackUrl", { ltr: true, placeholder: t("common", G.callback.placeholder) }),
          t("common", G.callback.hint),
          true,
        )}
      </div>
    ),

    review: (
      <ReviewStep
        form={form}
        owner={owner}
        money={money}
        onEdit={goTo}
      />
    ),
  };

  return (
    <Wizard
      title={t("common", F.createTitle)}
      icon={Landmark}
      steps={WIZARD_STEPS.map((s) => ({ id: s.id, title: t("common", W.steps[s.id].title), subtitle: t("common", W.steps[s.id].subtitle), icon: STEP_ICONS[s.id] }))}
      wizard={wizard}
      dirty={touched}
      closeQuestion={t("common", W.confirmClose)}
      busy={saving}
      submitLabel={t("common", saving ? W.creating : W.create)}
      onSubmit={() => void submit()}
      onClose={onClose}
      done={created ? <DoneScreen name={created} onAnother={restart} onFinish={onClose} /> : undefined}
      intro={<p className="text-xs text-text-secondary">{t("common", W.steps[step.id].subtitle)}</p>}
      tip={t("common", W.steps[step.id].tip)}
      error={failure}
    >
      {steps[step.id]}
    </Wizard>
  );
}

function ReviewStep({ form, owner, money, onEdit }: { form: GatewayForm; owner: boolean; money: (a: string) => string; onEdit: (id: WizardStepId) => void }) {
  const { t } = useLocale();
  const rangeText = useRangeText(money);
  const none = t("common", W.review.none);
  const provider = form.providerName as Provider;
  const category = form.gatewayCategory as (typeof CATEGORIES)[number];
  const secretState = (v: string) =>
    v.trim() ? (
      <span className="inline-flex items-center gap-1 text-success">
        <Check size={12} aria-hidden />
        {t("common", W.secrets.entered)}
      </span>
    ) : (
      <span className="text-text-secondary">{t("common", W.secrets.notEntered)}</span>
    );
  // A heads-up, not a block: the gateway saves and may go live without its keys (F-104-e).
  const missingSecrets = secretFields(form.providerName).some((f) => !form[f.slot].trim());

  const section = (id: WizardStepId, rows: [string, ReactNode][]) => (
    <section className="rounded-2xl border border-card-border bg-[var(--bg-inner)] p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-xs font-bold text-text-primary">
          {(() => {
            const Icon = STEP_ICONS[id];
            return <Icon size={14} className="text-primary" aria-hidden />;
          })()}
          {t("common", W.steps[id].title)}
        </h3>
        <Button variant="quiet" size="sm" onClick={() => onEdit(id)} className="text-primary hover:text-primary">
          {t("common", W.edit)}
        </Button>
      </div>
      <dl className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between gap-3 text-xs">
            <dt className="text-text-secondary">{k}</dt>
            <dd className="text-end font-bold text-text-primary">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );

  const feeText =
    form.feeCalculationMode === "automatic"
      ? t("common", W.feeModes.automatic.title)
      : form.feeType === "percentage"
        ? <span dir="ltr">{form.feeValue}%</span>
        : <span dir="ltr">{money(form.feeValue)}</span>;

  return (
    <div className="flex flex-col gap-3">
      {section("provider", [
        ...(owner ? ([[t("common", W.review.owner), form.source === "platform" ? t("common", W.owner.platform) : form.tenantId.trim() ? <span dir="ltr">{form.tenantId}</span> : t("common", W.owner.tenant)]] as [string, ReactNode][]) : []),
        [t("common", F.provider), provider ? <span dir="ltr">{applyProvider(emptyForm("tenant"), provider).displayName}</span> : none],
      ])}
      {section("details", [
        [t("common", F.displayName), form.displayName || none],
        [t("common", F.category), category ? t("common", W.categories[category]) : none],
        [t("common", W.review.range), <span key="r" dir="ltr">{rangeText(form.minAcceptAmount, form.maxAcceptAmount)}</span>],
        [t("common", F.isActive), form.isActive ? t("common", W.review.yes) : t("common", W.review.no)],
        [
          t("common", FrontendI18nKeys.common.gateways.presets.title),
          form.depositPresets.length > 0 ? (
            <span key="p" dir="ltr">
              {form.depositPresets.map((p) => money(p)).join(" · ")}
            </span>
          ) : (
            t("common", FrontendI18nKeys.common.gateways.presets.inherit)
          ),
        ],
      ])}
      {section("fee", [
        [t("common", F.feeValue), feeText],
        [t("common", W.review.floor), form.feeFloor ? <span dir="ltr">{money(form.feeFloor)}</span> : none],
        [t("common", W.review.ceiling), form.feeCeiling ? <span dir="ltr">{money(form.feeCeiling)}</span> : none],
        [t("common", G.tax.label), form.taxRatePercent.trim() ? <span dir="ltr">{form.taxRatePercent.trim()}%</span> : t("common", G.tax.inherit)],
      ])}
      {section("secrets", [
        ...providerFields(form.providerName).map(
          (f): [string, ReactNode] => [
            t("common", G.fields[f.label]),
            f.slot === "staticRate" ? (
              <span key="rate" dir="ltr">
                {form.staticRate.trim()} USD
              </span>
            ) : (
              secretState(form[f.slot])
            ),
          ],
        ),
        [
          t("common", G.callback.label),
          form.callbackUrl.trim() ? (
            <span key="cb" dir="ltr" className="break-all">
              {form.callbackUrl.trim()}
            </span>
          ) : (
            t("common", G.callback.default)
          ),
        ],
      ])}
      {missingSecrets && (
        <p className="flex items-start gap-2 rounded-xl border border-[var(--error-border)] bg-[var(--error-bg)] p-3 text-xs text-text-primary">
          <TriangleAlert size={14} className="mt-0.5 shrink-0 text-error" aria-hidden />
          {t("common", W.secrets.missing)}
        </p>
      )}
    </div>
  );
}

function DoneScreen({ name, onAnother, onFinish }: { name: string; onAnother: () => void; onFinish: () => void }) {
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
        <p className="mt-1 text-xs text-text-secondary">{t("common", W.done.subtitle)}</p>
      </div>
      <ol className="flex w-full max-w-md flex-col gap-2 text-start">
        {[W.done.step1, W.done.step2, W.done.step3].map((k, i) => (
          <li key={k} className="flex items-center gap-3 rounded-xl border border-card-border bg-[var(--bg-inner)] p-3 text-xs text-text-primary">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-[var(--leaf-bg)] text-2xs font-bold text-primary">{i + 1}</span>
            {t("common", k)}
          </li>
        ))}
      </ol>
      <div className="flex w-full max-w-md flex-col-reverse gap-2 sm:flex-row">
        <Button onClick={onAnother} className="flex-1">
          {t("common", W.done.another)}
        </Button>
        <Button variant="primary" onClick={onFinish} className="flex-1">
          {t("common", W.done.finish)}
        </Button>
      </div>
    </div>
  );
}
