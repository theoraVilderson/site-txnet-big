"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  ArrowLeft,
  ArrowRight,
  Bitcoin,
  Building2,
  Check,
  ChevronDown,
  CircleCheckBig,
  CreditCard,
  Eye,
  EyeOff,
  Globe,
  KeyRound,
  Landmark,
  Lightbulb,
  ListChecks,
  Loader2,
  Percent,
  ShieldCheck,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useApiErrorMessage } from "@/hooks/useApiError";
import type { Me } from "@/lib/auth-api";
import { billingApi } from "@/lib/billing-api";
import { Select } from "../../_components/kit/Select";
import { BASE_CURRENCY, formatMoney } from "../../_lib/money";
import {
  CATEGORIES,
  PROVIDERS,
  VERIFICATION,
  createBody,
  emptyForm,
  isPlatformOwner,
  type FormErrors,
  type GatewayForm,
} from "../_lib/gateway-form";
import {
  WIZARD_STEPS,
  applyProvider,
  feePreview,
  firstInvalidStep,
  stepErrors,
  type Provider,
  type WizardStepId,
} from "../_lib/gateway-wizard";

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
const PROVIDER_ICONS: Record<Provider, LucideIcon> = {
  zarinpal: Landmark,
  idpay: Landmark,
  nowpayments: Bitcoin,
  stripe: CreditCard,
};

const input =
  "w-full rounded-xl border border-card-border bg-[var(--bg-inner)] px-3 py-2.5 text-sm text-[var(--text-input)] placeholder:text-[var(--text-label)] transition-colors hover:border-[var(--accent-primary)] focus:border-[var(--accent-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-glow)]";
const invalidInput = "border-error focus:border-error";

interface GatewayWizardProps {
  me: Me | null;
  onClose: () => void;
  /** A gateway was created. The page re-reads its list; the wizard stays open on its done screen. */
  onCreated: () => void | Promise<void>;
}

/**
 * Add a gateway, one concern per step (F-102-e): provider → details → fee →
 * keys → review. Editing stays in `GatewayFormModal`; both build the same
 * {@link GatewayForm} and send it through `createBody`, so the wizard adds no
 * rule of its own.
 *
 * A full-screen sheet below `sm`, a dialog above it with the step list at the
 * side on `lg`. Secrets are write-only exactly as in the modal: the review step
 * says whether one was entered, never what it is.
 */
export function GatewayWizard({ me, onClose, onCreated }: GatewayWizardProps) {
  const { t, lang, isRtl } = useLocale();
  const errorMessage = useApiErrorMessage();
  const reduceMotion = useReducedMotion();
  const owner = isPlatformOwner(me);

  const [form, setForm] = useState<GatewayForm>(() => emptyForm("tenant"));
  const [stepIndex, setStepIndex] = useState(0);
  const [reached, setReached] = useState(0);
  const [direction, setDirection] = useState(1);
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const step = WIZARD_STEPS[stepIndex];
  const total = WIZARD_STEPS.length;
  const money = (amount: string) => formatMoney(amount, BASE_CURRENCY, { lang, t });

  const set = <K extends keyof GatewayForm>(k: K, v: GatewayForm[K]) => {
    setTouched(true);
    setForm((f) => ({ ...f, [k]: v }));
    if (errors[k]) setErrors((e) => ({ ...e, [k]: undefined }));
  };

  const requestClose = () => {
    if (touched && !created && !window.confirm(t("common", W.confirmClose))) return;
    onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  });

  const goTo = (index: number) => {
    setDirection(index > stepIndex ? 1 : -1);
    setStepIndex(index);
    setReached((r) => Math.max(r, index));
    setFailure(null);
    bodyRef.current?.scrollTo({ top: 0 });
  };

  const next = () => {
    const found = stepErrors(form, step.id);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    goTo(stepIndex + 1);
  };

  const submit = async () => {
    const bad = firstInvalidStep(form);
    if (bad) {
      setErrors(stepErrors(form, bad));
      goTo(WIZARD_STEPS.findIndex((s) => s.id === bad));
      return;
    }
    setSaving(true);
    setFailure(null);
    try {
      await billingApi.createGateway(createBody(form, me));
      setCreated(form.displayName.trim());
      await onCreated();
    } catch (e) {
      setFailure(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const restart = () => {
    setForm(emptyForm("tenant"));
    setErrors({});
    setCreated(null);
    setTouched(false);
    setStepIndex(0);
    setReached(0);
  };

  if (typeof document === "undefined") return null;

  const errorText = (k: keyof GatewayForm) =>
    errors[k] ? (
      <span role="alert" className="text-[11px] font-bold text-error">
        {t("common", G.errors[errors[k]!])}
      </span>
    ) : null;

  const labeled = (k: keyof GatewayForm, label: string, control: ReactNode, hint?: string, optional = false) => (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`gw-${k}`} className="flex items-center gap-2 text-xs font-bold text-text-primary">
        {label}
        {optional && <span className="font-normal text-text-secondary">({t("common", W.optional)})</span>}
      </label>
      {control}
      {errorText(k) ?? (hint && <span className="text-[11px] text-text-secondary">{hint}</span>)}
    </div>
  );

  const textInput = (k: keyof GatewayForm, opts: { ltr?: boolean; suffix?: string; placeholder?: string; decimal?: boolean } = {}) => (
    <div className="relative">
      <input
        id={`gw-${k}`}
        className={`${input} ${errors[k] ? invalidInput : ""} ${opts.suffix ? "pe-14" : ""}`}
        dir={opts.ltr ? "ltr" : undefined}
        inputMode={opts.decimal ? "decimal" : undefined}
        placeholder={opts.placeholder}
        aria-invalid={Boolean(errors[k])}
        value={String(form[k])}
        onChange={(e) => set(k, e.target.value as never)}
        onKeyDown={(e) => {
          if (e.key === "Enter") next();
        }}
      />
      {opts.suffix && (
        <span className="pointer-events-none absolute inset-y-0 end-3 flex items-center text-xs font-bold text-text-secondary">
          {opts.suffix}
        </span>
      )}
    </div>
  );

  /** Two or three mutually exclusive choices, as cards: every option visible, no list to open. */
  const choice = <V extends string>(
    name: string,
    value: string,
    options: readonly { value: V; title: string; desc?: string; icon?: LucideIcon }[],
    onPick: (v: V) => void,
  ) => (
    <div role="radiogroup" aria-label={name} className="grid gap-2 sm:grid-cols-2">
      {options.map((o) => {
        const selected = o.value === value;
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onPick(o.value)}
            className={`relative flex items-start gap-3 rounded-2xl border p-3 text-start transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-glow)] ${
              selected
                ? "border-[var(--accent-primary)] bg-[var(--leaf-bg)] shadow-sm"
                : "border-card-border bg-[var(--bg-inner)] hover:border-[var(--accent-primary)]"
            }`}
          >
            {Icon && (
              <span className={`grid size-9 shrink-0 place-items-center rounded-xl ${selected ? "bg-primary text-white" : "bg-card-bg text-primary"}`}>
                <Icon size={18} aria-hidden />
              </span>
            )}
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm font-bold text-text-primary">{o.title}</span>
              {o.desc && <span className="text-[11px] leading-5 text-text-secondary">{o.desc}</span>}
            </span>
            {selected && (
              <span className="absolute end-2 top-2 grid size-5 place-items-center rounded-full bg-primary text-white">
                <Check size={12} aria-hidden />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );

  const secretInput = (k: "merchantId" | "secretKey") => <SecretInput id={`gw-${k}`} value={form[k]} onChange={(v) => set(k, v)} showLabel={t("common", W.secrets.show)} hideLabel={t("common", W.secrets.hide)} />;

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
                    <span className={`grid size-10 place-items-center rounded-xl transition-colors ${selected ? "bg-primary text-white" : "bg-card-bg text-primary"}`}>
                      <Icon size={20} aria-hidden />
                    </span>
                    <span className="flex flex-col">
                      <span className="text-sm font-bold text-text-primary" dir="ltr">
                        {applyProvider(emptyForm("tenant"), p).displayName}
                      </span>
                      <span className="text-[11px] text-text-secondary">{t("common", W.categories[applyProvider(emptyForm("tenant"), p).gatewayCategory as (typeof CATEGORIES)[number]])}</span>
                    </span>
                  </span>
                  <span className="text-xs leading-5 text-text-secondary">{t("common", W.providers[p].desc)}</span>
                  {selected && (
                    <span className="absolute end-3 top-3 grid size-6 place-items-center rounded-full bg-primary text-white">
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
        {labeled("minAcceptAmount", t("common", F.minAmount), textInput("minAcceptAmount", { ltr: true, decimal: true, suffix: BASE_CURRENCY, placeholder: "1" }))}
        {labeled("maxAcceptAmount", t("common", F.maxAmount), textInput("maxAcceptAmount", { ltr: true, decimal: true, suffix: BASE_CURRENCY, placeholder: "500" }))}
        <p className="-mt-2 text-[11px] text-text-secondary sm:col-span-2">{t("common", W.hints.amounts)}</p>
        <div className="sm:col-span-2">
          <Toggle
            checked={form.isActive}
            onChange={(v) => set("isActive", v)}
            label={t("common", F.isActive)}
            hint={t("common", W.hints.isActive)}
          />
        </div>
      </div>
    ),

    fee: <FeeStep form={form} set={set} errors={errors} textInput={textInput} labeled={labeled} choice={choice} money={money} />,

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
          {labeled("merchantId", t("common", G.merchantId), secretInput("merchantId"), undefined, true)}
          {labeled("secretKey", t("common", G.secretKey), secretInput("secretKey"), undefined, true)}
        </div>
        <p className="flex items-center gap-1.5 text-[11px] font-bold text-success">
          <ShieldCheck size={14} aria-hidden />
          {t("common", W.secrets.safe)}
        </p>
        {owner && form.source === "tenant" && (
          <div className="sm:max-w-xs">
            {labeled(
              "verificationStatus",
              t("common", F.verification),
              <Select
                value={form.verificationStatus}
                onChange={(v) => set("verificationStatus", v)}
                ariaLabel={t("common", F.verification)}
                placeholder="—"
                options={VERIFICATION.map((v) => ({ value: v, label: t("common", W.verification[v]) }))}
              />,
              undefined,
              true,
            )}
          </div>
        )}
      </div>
    ),

    review: (
      <ReviewStep
        form={form}
        owner={owner}
        money={money}
        onEdit={(id) => goTo(WIZARD_STEPS.findIndex((s) => s.id === id))}
      />
    ),
  };

  const StepIcon = STEP_ICONS[step.id];
  const slide = reduceMotion ? {} : { x: direction * (isRtl ? -24 : 24), opacity: 0 };
  const progress = ((stepIndex + 1) / total) * 100;
  const BackIcon = isRtl ? ArrowRight : ArrowLeft;
  const NextIcon = isRtl ? ArrowLeft : ArrowRight;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/50 backdrop-blur-sm sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && requestClose()}>
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby="gw-wizard-title"
        initial={reduceMotion ? false : { opacity: 0, y: 24, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.2 }}
        className="flex h-full w-full flex-col overflow-hidden border-card-border bg-card-bg shadow-2xl sm:h-auto sm:max-h-[92vh] sm:max-w-2xl sm:rounded-3xl sm:border lg:max-w-4xl lg:flex-row"
      >
        {/* Step list — the side rail on lg, hidden below it where the progress bar says the same. */}
        <aside className="hidden w-64 shrink-0 flex-col gap-1 border-e border-card-border bg-[var(--bg-inner)] p-5 lg:flex">
          <p className="mb-3 flex items-center gap-2 text-sm font-bold text-text-primary">
            <Landmark size={16} className="text-primary" aria-hidden />
            {t("common", F.createTitle)}
          </p>
          <ol className="flex flex-col gap-1">
            {WIZARD_STEPS.map((s, i) => {
              const Icon = STEP_ICONS[s.id];
              const done = i < stepIndex || Boolean(created);
              const current = i === stepIndex && !created;
              const reachable = i <= reached && !created && !saving;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    disabled={!reachable}
                    onClick={() => goTo(i)}
                    aria-current={current ? "step" : undefined}
                    className={`flex w-full items-center gap-3 rounded-xl px-2 py-2 text-start transition-colors disabled:cursor-default ${
                      current ? "bg-card-bg shadow-sm" : reachable ? "hover:bg-card-bg" : ""
                    }`}
                  >
                    <span
                      className={`grid size-8 shrink-0 place-items-center rounded-full border text-xs font-bold transition-colors ${
                        done
                          ? "border-transparent bg-primary text-white"
                          : current
                            ? "border-[var(--accent-primary)] bg-[var(--leaf-bg)] text-primary"
                            : "border-card-border text-text-secondary"
                      }`}
                    >
                      {done ? <Check size={14} aria-hidden /> : <Icon size={14} aria-hidden />}
                    </span>
                    <span className="flex flex-col">
                      <span className={`text-xs font-bold ${current || done ? "text-text-primary" : "text-text-secondary"}`}>{t("common", W.steps[s.id].title)}</span>
                      <span className="line-clamp-1 text-[10px] text-text-secondary">{t("common", W.steps[s.id].subtitle)}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="shrink-0 border-b border-card-border px-4 pb-3 pt-4 sm:px-6">
            <div className="flex items-start justify-between gap-3">
              {created ? (
                <span id="gw-wizard-title" className="text-sm font-bold text-text-primary">
                  {t("common", F.createTitle)}
                </span>
              ) : (
                <div className="flex min-w-0 items-center gap-3">
                  <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[var(--leaf-bg)] text-primary">
                    <StepIcon size={20} aria-hidden />
                  </span>
                  <div className="min-w-0">
                    <p className="text-[11px] font-bold text-text-secondary">
                      {t("common", W.stepOf, { current: String(stepIndex + 1), total: String(total) })}
                    </p>
                    <h2 id="gw-wizard-title" className="truncate text-base font-bold text-text-primary">
                      {t("common", W.steps[step.id].title)}
                    </h2>
                  </div>
                </div>
              )}
              <button
                type="button"
                onClick={requestClose}
                aria-label={t("common", W.close)}
                className="grid size-9 shrink-0 place-items-center rounded-xl text-text-secondary transition-colors hover:bg-[var(--bg-inner)] hover:text-text-primary"
              >
                <X size={18} />
              </button>
            </div>
            {!created && (
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--leaf-bg)]" role="progressbar" aria-valuemin={1} aria-valuemax={total} aria-valuenow={stepIndex + 1}>
                <motion.div className="h-full rounded-full bg-primary" animate={{ width: `${progress}%` }} transition={{ duration: reduceMotion ? 0 : 0.3 }} />
              </div>
            )}
          </header>

          <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
            {created ? (
              <DoneScreen name={created} onAnother={restart} onFinish={onClose} />
            ) : (
              <AnimatePresence mode="wait" initial={false}>
                <motion.div key={step.id} initial={slide} animate={{ x: 0, opacity: 1 }} exit={reduceMotion ? {} : { opacity: 0 }} transition={{ duration: 0.18 }} className="flex flex-col gap-5">
                  <p className="text-xs text-text-secondary">{t("common", W.steps[step.id].subtitle)}</p>
                  {steps[step.id]}
                  <aside className="flex items-start gap-3 rounded-2xl border border-dashed border-[var(--gold-primary)]/50 bg-[var(--gold-bg)] p-3">
                    <Lightbulb size={16} className="mt-0.5 shrink-0 text-[var(--gold-primary)]" aria-hidden />
                    <p className="text-xs leading-6 text-text-primary">
                      <b>{t("common", W.tip)}: </b>
                      {t("common", W.steps[step.id].tip)}
                    </p>
                  </aside>
                  {failure && (
                    <p role="alert" className="flex items-center gap-2 rounded-xl border border-[var(--error-border)] bg-[var(--error-bg)] p-3 text-xs font-bold text-error">
                      <TriangleAlert size={14} aria-hidden />
                      {failure}
                    </p>
                  )}
                </motion.div>
              </AnimatePresence>
            )}
          </div>

          {!created && (
            <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-card-border bg-card-bg px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
              {stepIndex > 0 ? (
                <button
                  type="button"
                  onClick={() => goTo(stepIndex - 1)}
                  disabled={saving}
                  className="inline-flex items-center gap-1.5 rounded-xl px-3 py-2.5 text-sm font-bold text-text-secondary transition-colors hover:bg-[var(--bg-inner)] hover:text-text-primary disabled:opacity-50"
                >
                  <BackIcon size={16} aria-hidden />
                  {t("common", W.back)}
                </button>
              ) : (
                <button type="button" onClick={requestClose} className="rounded-xl px-3 py-2.5 text-sm font-bold text-text-secondary hover:bg-[var(--bg-inner)]">
                  {t("common", F.cancel)}
                </button>
              )}
              {step.id === "review" ? (
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void submit()}
                  className="inline-flex min-w-36 items-center justify-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-bold text-white shadow-md transition-all hover:brightness-110 disabled:opacity-60"
                >
                  {saving ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Check size={16} aria-hidden />}
                  {t("common", saving ? W.creating : W.create)}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={next}
                  className="inline-flex min-w-32 items-center justify-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-bold text-white shadow-md transition-all hover:brightness-110"
                >
                  {t("common", W.next)}
                  <NextIcon size={16} aria-hidden />
                </button>
              )}
            </footer>
          )}
        </div>
      </motion.div>
    </div>,
    document.body,
  );
}

type Set = <K extends keyof GatewayForm>(k: K, v: GatewayForm[K]) => void;

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between gap-3 rounded-2xl border border-card-border bg-[var(--bg-inner)] p-3 text-start transition-colors hover:border-[var(--accent-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-glow)]"
    >
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-bold text-text-primary">{label}</span>
        {hint && <span className="text-[11px] text-text-secondary">{hint}</span>}
      </span>
      <span className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? "bg-primary" : "bg-[var(--leaf-bg)] ring-1 ring-inset ring-card-border"}`}>
        <span className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-all ${checked ? "start-[1.375rem]" : "start-0.5"}`} />
      </span>
    </button>
  );
}

function SecretInput({ id, value, onChange, showLabel, hideLabel }: { id: string; value: string; onChange: (v: string) => void; showLabel: string; hideLabel: string }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <input
        id={id}
        className={`${input} pe-11 font-mono`}
        dir="ltr"
        type={visible ? "text" : "password"}
        autoComplete="new-password"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? hideLabel : showLabel}
        className="absolute inset-y-0 end-1 grid w-9 place-items-center text-text-secondary hover:text-text-primary"
      >
        {visible ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
      </button>
    </div>
  );
}

interface FeeStepProps {
  form: GatewayForm;
  set: Set;
  errors: FormErrors;
  textInput: (k: keyof GatewayForm, opts?: { ltr?: boolean; suffix?: string; placeholder?: string; decimal?: boolean }) => ReactNode;
  labeled: (k: keyof GatewayForm, label: string, control: ReactNode, hint?: string, optional?: boolean) => ReactNode;
  choice: <V extends string>(name: string, value: string, options: readonly { value: V; title: string; desc?: string; icon?: LucideIcon }[], onPick: (v: V) => void) => ReactNode;
  money: (amount: string) => string;
}

function FeeStep({ form, set, errors, textInput, labeled, choice, money }: FeeStepProps) {
  const { t } = useLocale();
  const [sample, setSample] = useState("100");
  const [advanced, setAdvanced] = useState(Boolean(form.feeFloor || form.feeCeiling || errors.feeFloor || errors.feeCeiling));
  const manual = form.feeCalculationMode === "manual";
  const fee = useMemo(() => feePreview(form, sample), [form, sample]);

  return (
    <div className="flex flex-col gap-5">
      {choice(
        t("common", F.feeMode),
        form.feeCalculationMode,
        [
          { value: "manual", title: t("common", W.feeModes.manual.title), desc: t("common", W.feeModes.manual.desc), icon: Percent },
          { value: "automatic", title: t("common", W.feeModes.automatic.title), desc: t("common", W.feeModes.automatic.desc), icon: CircleCheckBig },
        ] as const,
        (v) => set("feeCalculationMode", v),
      )}

      {manual ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-bold text-text-primary">{t("common", F.feeType)}</span>
            <div role="radiogroup" aria-label={t("common", F.feeType)} className="grid grid-cols-2 gap-1 rounded-xl border border-card-border bg-[var(--bg-inner)] p-1">
              {(["percentage", "fixed"] as const).map((ft) => (
                <button
                  key={ft}
                  type="button"
                  role="radio"
                  aria-checked={form.feeType === ft}
                  onClick={() => set("feeType", ft)}
                  className={`rounded-lg px-2 py-2 text-xs font-bold transition-all ${form.feeType === ft ? "bg-primary text-white shadow-sm" : "text-text-secondary hover:text-text-primary"}`}
                >
                  {t("common", W.feeTypes[ft])}
                </button>
              ))}
            </div>
          </div>
          {labeled("feeValue", t("common", F.feeValue), textInput("feeValue", { ltr: true, decimal: true, suffix: form.feeType === "percentage" ? "%" : BASE_CURRENCY }))}
        </div>
      ) : (
        <p className="rounded-xl bg-[var(--leaf-bg)] p-3 text-xs text-text-primary">{t("common", W.hints.automaticNote)}</p>
      )}

      <div className="rounded-2xl border border-card-border">
        <button
          type="button"
          onClick={() => setAdvanced((a) => !a)}
          aria-expanded={advanced}
          className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-xs font-bold text-text-primary"
        >
          <span>
            {t("common", W.hints.advanced)} <span className="font-normal text-text-secondary">({t("common", W.optional)})</span>
          </span>
          <ChevronDown size={16} className={`text-text-secondary transition-transform ${advanced ? "rotate-180" : ""}`} aria-hidden />
        </button>
        {advanced && (
          <div className="grid gap-4 border-t border-card-border p-3 sm:grid-cols-2">
            {labeled("feeFloor", t("common", F.feeFloor), textInput("feeFloor", { ltr: true, decimal: true, suffix: BASE_CURRENCY }))}
            {labeled("feeCeiling", t("common", F.feeCeiling), textInput("feeCeiling", { ltr: true, decimal: true, suffix: BASE_CURRENCY }))}
          </div>
        )}
      </div>

      {manual && (
        <div className="rounded-2xl bg-[image:var(--card-gradient)] p-4 text-white shadow-md">
          <p className="mb-3 text-xs font-bold opacity-90">{t("common", W.preview.title)}</p>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <label className="flex flex-col gap-1 text-[11px] opacity-90">
              {t("common", W.preview.amount)}
              <span className="relative">
                <input
                  dir="ltr"
                  inputMode="decimal"
                  value={sample}
                  onChange={(e) => setSample(e.target.value)}
                  className="w-32 rounded-lg border border-white/30 bg-white/15 px-2 py-1.5 pe-10 text-sm font-bold text-white placeholder:text-white/60 focus:outline-none focus:ring-2 focus:ring-white/40"
                />
                <span className="pointer-events-none absolute inset-y-0 end-2 flex items-center text-[10px] font-bold opacity-80">{BASE_CURRENCY}</span>
              </span>
            </label>
            <div className="text-end">
              <p className="text-[11px] opacity-90">{t("common", W.preview.fee)}</p>
              <p className="text-xl font-bold" dir="ltr">
                {fee === null ? "—" : money(fee)}
              </p>
            </div>
          </div>
          {fee === null && sample.trim() !== "" && <p className="mt-2 text-[11px] opacity-90">{t("common", W.preview.invalid)}</p>}
        </div>
      )}
    </div>
  );
}

function ReviewStep({ form, owner, money, onEdit }: { form: GatewayForm; owner: boolean; money: (a: string) => string; onEdit: (id: WizardStepId) => void }) {
  const { t } = useLocale();
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
  const missingSecrets = !form.merchantId.trim() && !form.secretKey.trim();

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
        <button type="button" onClick={() => onEdit(id)} className="rounded-lg px-2 py-1 text-[11px] font-bold text-primary hover:bg-card-bg">
          {t("common", W.edit)}
        </button>
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
        [t("common", W.review.range), <span key="r" dir="ltr">{`${money(form.minAcceptAmount || "0")} – ${money(form.maxAcceptAmount || "0")}`}</span>],
        [t("common", F.isActive), form.isActive ? t("common", W.review.yes) : t("common", W.review.no)],
      ])}
      {section("fee", [
        [t("common", F.feeValue), feeText],
        [t("common", W.review.floor), form.feeFloor ? <span dir="ltr">{money(form.feeFloor)}</span> : none],
        [t("common", W.review.ceiling), form.feeCeiling ? <span dir="ltr">{money(form.feeCeiling)}</span> : none],
      ])}
      {section("secrets", [
        [t("common", G.merchantId), secretState(form.merchantId)],
        [t("common", G.secretKey), secretState(form.secretKey)],
        ...(owner && form.source === "tenant" && form.verificationStatus
          ? ([[t("common", F.verification), t("common", W.verification[form.verificationStatus as (typeof VERIFICATION)[number]])]] as [string, ReactNode][])
          : []),
      ])}
      {missingSecrets && (
        <p className="flex items-start gap-2 rounded-xl border border-[var(--gold-primary)]/40 bg-[var(--gold-bg)] p-3 text-xs text-text-primary">
          <TriangleAlert size={14} className="mt-0.5 shrink-0 text-[var(--gold-primary)]" aria-hidden />
          {t("common", W.secrets.missing)}
        </p>
      )}
    </div>
  );
}

function DoneScreen({ name, onAnother, onFinish }: { name: string; onAnother: () => void; onFinish: () => void }) {
  const { t } = useLocale();
  const reduceMotion = useReducedMotion();
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
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-[var(--leaf-bg)] text-[11px] font-bold text-primary">{i + 1}</span>
            {t("common", k)}
          </li>
        ))}
      </ol>
      <div className="flex w-full max-w-md flex-col-reverse gap-2 sm:flex-row">
        <button type="button" onClick={onAnother} className="flex-1 rounded-xl border border-card-border px-4 py-2.5 text-sm font-bold text-text-primary hover:bg-[var(--bg-inner)]">
          {t("common", W.done.another)}
        </button>
        <button type="button" onClick={onFinish} className="flex-1 rounded-xl bg-primary px-4 py-2.5 text-sm font-bold text-white shadow-md hover:brightness-110">
          {t("common", W.done.finish)}
        </button>
      </div>
    </div>
  );
}
