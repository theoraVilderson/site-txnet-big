"use client";

import { Fragment, useState, type ReactNode } from "react";
import { Building2, Globe, Landmark, ShieldCheck, type LucideIcon } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useGatewayMessage, type GatewaySurface } from "../_lib/surface";
import type { Me } from "@/lib/auth-api";
import type { AdminGateway, GatewaySecretName } from "@/lib/billing-api";
import { isManualProvider } from "@/lib/billing/manual-transfer";
import { Select } from "../../_components/kit/Select";
import { PresetsEditor } from "./PresetsEditor";
import { formatMoney } from "../../_lib/money";
import { CATEGORIES, createBody, emptyForm, type FormErrors, type GatewayForm } from "../_lib/gateway-form";
import { WIZARD_STEPS, firstInvalidStep, stepErrors, type Provider, type WizardStepId } from "../_lib/gateway-wizard";
import { providerFields, secretFields } from "../_lib/provider-fields";
import { ChoiceCards, FeeFields, Field, PROVIDER_ICONS, SecretInput } from "./gateway-fields";
import { ManualSettingFields } from "./manual/ManualSettingFields";
import { WizardProviderPicker } from "./WizardProviderPicker";
import { DoneScreen, ReviewStep, STEP_ICONS } from "./WizardReview";
import { Toggle } from "../../_components/kit/Toggle";
import { Wizard, useWizard } from "../../_components/kit/Wizard";
import { Input } from "../../_components/kit";
import { isPlatformTenant } from "@/lib/tenant-type";

const G = FrontendI18nKeys.common.gateways;
const F = G.form;
const W = G.wizard;
const M = G.manual;

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
  /** A manual gateway was created: open its cards or wallets (F-803-g) — it is offered only once one is active. */
  onAddDestination?: (gateway: AdminGateway) => void;
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
export function GatewayWizard({ surface, me, currency, onClose, onCreated, onAddDestination }: GatewayWizardProps) {
  const { t, lang } = useLocale();
  const errorMessage = useGatewayMessage(surface);
  const owner = isPlatformTenant(me?.tenant?.type);

  const initialForm = () => emptyForm(owner ? "platform" : "tenant");
  const [form, setForm] = useState<GatewayForm>(initialForm);
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [created, setCreated] = useState<AdminGateway | null>(null);
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
      setCreated(await surface.api.create(createBody(form, me)));
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

  // A manual gateway's kind fixes its category, and its keys step asks for proof (F-803-g).
  const manual = isManualProvider(form.providerName);
  const provider = (manual ? "" : form.providerName) as Provider | "";
  const copyOf = (id: WizardStepId) => (id === "secrets" && manual ? M.proofStep : W.steps[id]);

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
        <WizardProviderPicker
          form={form}
          error={errors.providerName}
          onPick={(next) => {
            setTouched(true);
            setForm(next);
            setErrors({});
          }}
        />
      </div>
    ),

    details: (
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          {labeled("displayName", t("common", F.displayName), textInput("displayName", { placeholder: t("common", W.hints.displayName) }))}
        </div>
        <div className={manual ? "hidden" : "sm:col-span-2"}>
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

    secrets: manual ? (
      <ManualSettingFields form={form} set={set} errors={errors} />
    ) : (
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
      steps={WIZARD_STEPS.map((s) => ({ id: s.id, title: t("common", copyOf(s.id).title), subtitle: t("common", copyOf(s.id).subtitle), icon: STEP_ICONS[s.id] }))}
      wizard={wizard}
      dirty={touched}
      closeQuestion={t("common", W.confirmClose)}
      busy={saving}
      submitLabel={t("common", saving ? W.creating : W.create)}
      onSubmit={() => void submit()}
      onClose={onClose}
      done={
        created ? (
          <DoneScreen
            name={created.displayName}
            onAnother={restart}
            onFinish={onClose}
            onAddDestination={created.manual && onAddDestination ? () => onAddDestination(created) : undefined}
          />
        ) : undefined
      }
      intro={<p className="text-xs text-text-secondary">{t("common", copyOf(step.id).subtitle)}</p>}
      tip={t("common", copyOf(step.id).tip)}
      error={failure}
    >
      {steps[step.id]}
    </Wizard>
  );
}
