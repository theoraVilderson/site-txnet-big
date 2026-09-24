"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  ArrowLeft,
  ArrowRight,
  Boxes,
  Check,
  ChevronDown,
  Clock,
  FlaskConical,
  Gauge,
  KeyRound,
  Lightbulb,
  ListChecks,
  Loader2,
  Plug,
  Router,
  Server,
  ShieldCheck,
  Sparkles,
  Tag,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { fieldErrorsByPath } from "@/lib/api-error";
import { billingApi, type RegisteredPanel } from "@/lib/billing-api";
import { ChoiceCards, SecretInput } from "../../gateways/_components/gateway-fields";
import {
  COUNTER_SEMANTICS,
  DRIVER_LABELS,
  DRIVER_TYPES,
  PANEL_ROLES,
  PANEL_TRANSPORTS,
  SYSTEMS_KEYS,
  emptyRegisterForm,
  validateRegister,
  type RegisterForm,
} from "../_lib/systems";
import {
  DRIVER_PROFILES,
  FAMILY_GROUPS,
  REGISTER_STEPS,
  applyDriver,
  composeLogin,
  emptyLoginParts,
  firstInvalidRegisterStep,
  ipOfUrl,
  registerStepErrors,
  type FamilyGroup,
  type LoginParts,
  type RegisterStepId,
  type WizardErrors,
} from "../_lib/register-wizard";
import { useSystemsError } from "./parts";

const R = SYSTEMS_KEYS.register;
const F = R.field;
const W = R.wizard;

type DriverType = (typeof DRIVER_TYPES)[number];

const STEP_ICONS: Record<RegisterStepId, LucideIcon> = {
  family: Boxes,
  details: Tag,
  connection: Plug,
  login: KeyRound,
  review: ListChecks,
};

const GROUP_ICONS: Record<FamilyGroup, LucideIcon> = { xray: Server, router: Router, test: FlaskConical };

/** Blank is billing's default of 60 (`validateRegister`). */
const BUDGET_PRESETS = [
  { value: "30", label: W.budget.gentle },
  { value: "", label: W.budget.default },
  { value: "120", label: W.budget.fast },
] as const;

const input =
  "w-full rounded-xl border border-card-border bg-[var(--bg-inner)] px-3 py-2.5 text-sm text-[var(--text-input)] placeholder:text-[var(--text-label)] transition-colors hover:border-[var(--accent-primary)] focus:border-[var(--accent-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-glow)]";
const invalidInput = "border-error focus:border-error";

/**
 * Register a panel, one concern per step (F-027-bq): family → details →
 * connection → login → review. The same {@link RegisterForm} the old form sent
 * and `validateRegister` still decides what billing is sent; the family fills
 * transport and counting, and the login is asked in its parts and composed
 * the way the Opener reads it. Laid out as `GatewayWizard`: a sheet below
 * `sm`, a dialog above it, the step rail at the side on `lg`.
 *
 * The login never outlives the call: parts and form are reset on success, and
 * the done screen says only what the answer's `configured` flags say.
 */
export function RegisterWizard({ onClose, onRegistered }: { onClose: () => void; onRegistered: () => Promise<void> }) {
  const { t, isRtl } = useLocale();
  const message = useSystemsError();
  const reduceMotion = useReducedMotion();

  const [form, setForm] = useState<RegisterForm>(() => applyDriver(emptyRegisterForm(), "marzban"));
  const [parts, setParts] = useState<LoginParts>(emptyLoginParts);
  const [stepIndex, setStepIndex] = useState(0);
  const [reached, setReached] = useState(0);
  const [direction, setDirection] = useState(1);
  const [errors, setErrors] = useState<WizardErrors>({});
  /** Billing's own words for a field it refused, by field — shown until that field changes. */
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<{ name: string; answer: RegisteredPanel } | null>(null);
  const [touched, setTouched] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const step = REGISTER_STEPS[stepIndex];
  const total = REGISTER_STEPS.length;
  const profile = DRIVER_PROFILES[form.driverType];

  const clear = (k: keyof WizardErrors) => {
    if (errors[k]) setErrors((e) => ({ ...e, [k]: undefined }));
    if (serverErrors[k]) setServerErrors((e) => ({ ...e, [k]: "" }));
  };

  const set = <K extends keyof RegisterForm>(k: K, v: RegisterForm[K]) => {
    setTouched(true);
    setForm((f) => ({ ...f, [k]: v }));
    clear(k);
  };

  const setPart = (k: keyof LoginParts, v: string) => {
    setTouched(true);
    const next = { ...parts, [k]: v };
    setParts(next);
    setForm((f) => ({ ...f, credentials: composeLogin(DRIVER_PROFILES[f.driverType].login, next) }));
    clear(k);
    clear("credentials");
  };

  const pickDriver = (d: DriverType) => {
    setTouched(true);
    setForm((f) => ({ ...applyDriver(f, d), credentials: composeLogin(DRIVER_PROFILES[d].login, parts) }));
    setErrors({});
  };

  const requestClose = () => {
    if (touched && !done && !window.confirm(t("common", W.confirmClose))) return;
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
    const found = registerStepErrors(form, parts, step.id);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    goTo(stepIndex + 1);
  };

  const submit = async () => {
    const bad = firstInvalidRegisterStep(form, parts);
    const checked = validateRegister(form);
    if (bad || !checked.ok) {
      const at = bad ?? "details";
      setErrors(registerStepErrors(form, parts, at));
      goTo(REGISTER_STEPS.findIndex((s) => s.id === at));
      return;
    }
    setSaving(true);
    setFailure(null);
    try {
      const answer = await billingApi.registerPanel(checked.body);
      setDone({ name: checked.body.name, answer });
      setForm(applyDriver(emptyRegisterForm(), "marzban"));
      setParts(emptyLoginParts());
      await onRegistered();
    } catch (e) {
      // A field billing refused sends the operator back to the step that owns it.
      const byField = fieldErrorsByPath(e);
      setServerErrors(byField);
      const owner = REGISTER_STEPS.find((s) => s.fields.some((f) => byField[f]));
      if (owner) goTo(REGISTER_STEPS.indexOf(owner));
      setFailure(message(e));
    } finally {
      setSaving(false);
    }
  };

  const restart = () => {
    setForm(applyDriver(emptyRegisterForm(), "marzban"));
    setParts(emptyLoginParts());
    setErrors({});
    setServerErrors({});
    setDone(null);
    setTouched(false);
    setStepIndex(0);
    setReached(0);
  };

  if (typeof document === "undefined") return null;

  const errorText = (k: keyof WizardErrors) => {
    const text = errors[k] ? t("common", errors[k]!) : serverErrors[k];
    if (!text) return null;
    return (
      <motion.span initial={reduceMotion ? false : { opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} role="alert" className="text-[11px] font-bold text-error">
        {text}
      </motion.span>
    );
  };

  const labeled = (k: keyof WizardErrors, label: string, control: ReactNode, hint?: string, optional = false) => (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`rp-${k}`} className="flex items-center gap-2 text-xs font-bold text-text-primary">
        {label}
        {optional && <span className="font-normal text-text-secondary">({t("common", W.optional)})</span>}
      </label>
      {control}
      {errorText(k) ?? (hint && <span className="text-[11px] leading-5 text-text-secondary">{hint}</span>)}
    </div>
  );

  const textInput = (k: keyof RegisterForm, opts: { ltr?: boolean; placeholder?: string; numeric?: boolean; maxLength?: number } = {}) => (
    <input
      id={`rp-${k}`}
      dir={opts.ltr ? "ltr" : undefined}
      className={`${input} ${errors[k] || serverErrors[k] ? invalidInput : ""} ${opts.ltr ? "font-mono" : ""}`}
      inputMode={opts.numeric ? "numeric" : undefined}
      placeholder={opts.placeholder}
      maxLength={opts.maxLength}
      aria-invalid={Boolean(errors[k])}
      value={String(form[k])}
      onChange={(e) => set(k, e.target.value as never)}
      onKeyDown={(e) => {
        if (e.key === "Enter") next();
      }}
    />
  );

  const secret = (k: keyof LoginParts | "radiusSecret", value: string, onChange: (v: string) => void) => (
    <SecretInput id={`rp-${k}`} value={value} onChange={onChange} showLabel={t("common", W.login.show)} hideLabel={t("common", W.login.hide)} />
  );

  const apiHint = form.driverType === "hiddify" ? W.apiBaseUrlHint.hiddify : profile.group === "router" ? W.apiBaseUrlHint.router : W.apiBaseUrlHint.default;
  const suggestedIp = ipOfUrl(form.apiBaseUrl);

  const steps: Record<RegisterStepId, ReactNode> = {
    family: (
      <div className="flex flex-col gap-5">
        {FAMILY_GROUPS.map((group, gi) => {
          const GroupIcon = GROUP_ICONS[group];
          const members = DRIVER_TYPES.filter((d) => DRIVER_PROFILES[d].group === group);
          return (
            <section key={group} className="flex flex-col gap-2">
              <h3 className="flex items-center gap-2 text-xs font-bold text-text-secondary">
                <GroupIcon size={14} aria-hidden />
                {t("common", W.groups[group])}
              </h3>
              <div role="radiogroup" aria-label={t("common", W.groups[group])} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {members.map((d, i) => {
                  const selected = form.driverType === d;
                  const ready = DRIVER_PROFILES[d].supported;
                  return (
                    <motion.button
                      key={d}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => pickDriver(d)}
                      initial={reduceMotion ? false : { opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: reduceMotion ? 0 : gi * 0.08 + i * 0.03, type: "spring", stiffness: 320, damping: 26 }}
                      whileHover={reduceMotion ? undefined : { y: -2 }}
                      whileTap={reduceMotion ? undefined : { scale: 0.98 }}
                      className={`relative flex items-center gap-3 overflow-hidden rounded-2xl border p-3 text-start transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-glow)] ${
                        selected ? "border-[var(--accent-primary)] shadow-md" : "border-card-border bg-[var(--bg-inner)] hover:border-[var(--accent-primary)]"
                      } ${ready ? "" : "opacity-80"}`}
                    >
                      {selected && (
                        <motion.span
                          layoutId="rp-family-selected"
                          className="absolute inset-0 -z-0 bg-[var(--leaf-bg)]"
                          transition={{ type: "spring", stiffness: 380, damping: 32 }}
                          aria-hidden
                        />
                      )}
                      <span className={`relative grid size-9 shrink-0 place-items-center rounded-xl transition-colors ${selected ? "bg-primary text-white" : "bg-card-bg text-primary"}`}>
                        <GroupIcon size={18} aria-hidden />
                      </span>
                      <span className="relative flex min-w-0 flex-col gap-1">
                        <span className="truncate text-sm font-bold text-text-primary" dir="ltr">
                          {DRIVER_LABELS[d]}
                        </span>
                        <span
                          className={`inline-flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${
                            ready ? "bg-[var(--leaf-bg)] text-success" : "bg-card-bg text-text-secondary"
                          }`}
                        >
                          {ready ? <Check size={10} aria-hidden /> : <Clock size={10} aria-hidden />}
                          {t("common", ready ? W.ready : W.notReady)}
                        </span>
                      </span>
                      <AnimatePresence>
                        {selected && (
                          <motion.span
                            initial={reduceMotion ? false : { scale: 0 }}
                            animate={{ scale: 1 }}
                            exit={reduceMotion ? undefined : { scale: 0 }}
                            transition={{ type: "spring", stiffness: 500, damping: 22 }}
                            className="absolute end-2 top-2 grid size-5 place-items-center rounded-full bg-primary text-white"
                          >
                            <Check size={12} aria-hidden />
                          </motion.span>
                        )}
                      </AnimatePresence>
                    </motion.button>
                  );
                })}
              </div>
            </section>
          );
        })}
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={form.driverType}
            initial={reduceMotion ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? undefined : { opacity: 0, y: -6 }}
            transition={{ duration: 0.16 }}
            className="flex flex-col gap-2 rounded-2xl border border-card-border bg-[var(--bg-inner)] p-3"
          >
            <p className="text-xs font-bold text-text-primary">
              {t("common", W.profile.title)} <span dir="ltr">{DRIVER_LABELS[form.driverType]}</span>
            </p>
            <div className="flex flex-wrap gap-1.5 text-[11px]">
              <Chip>{t("common", R.transport[profile.transport])}</Chip>
              <Chip>{t("common", R.counter[profile.counterSemantics])}</Chip>
              <Chip>{t("common", profile.login === "apiKey" ? W.profile.apiKey : W.profile.userPassword)}</Chip>
              {profile.clientBaseUrl && <Chip>{t("common", W.profile.clientBaseUrl)}</Chip>}
            </div>
            {!profile.supported && (
              <p className="flex items-start gap-2 text-[11px] leading-5 text-text-secondary">
                <Clock size={12} className="mt-1 shrink-0" aria-hidden />
                {t("common", W.notReadyNote)}
              </p>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    ),

    details: (
      <div className="grid gap-4 sm:grid-cols-2">
        {labeled("name", t("common", F.name), textInput("name", { placeholder: t("common", W.placeholder.name), maxLength: 100 }))}
        {labeled("region", t("common", F.region), textInput("region", { placeholder: t("common", W.placeholder.region), maxLength: 50 }))}
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <span className="text-xs font-bold text-text-primary">{t("common", F.role)}</span>
          <ChoiceCards
            name={t("common", F.role)}
            value={form.role}
            options={PANEL_ROLES.map((r) => ({ value: r, title: t("common", W.role[r].title), desc: t("common", W.role[r].desc), icon: r === "active" ? Sparkles : ShieldCheck }))}
            onPick={(v) => set("role", v)}
          />
        </div>
      </div>
    ),

    connection: (
      <div className="flex flex-col gap-4">
        {labeled(
          "apiBaseUrl",
          t("common", F.apiBaseUrl),
          textInput("apiBaseUrl", { ltr: true, placeholder: t("common", W.placeholder.apiBaseUrl), maxLength: 500 }),
          t("common", apiHint),
        )}
        {profile.clientBaseUrl &&
          form.transport === "pull" &&
          labeled(
            "clientBaseUrl",
            t("common", F.clientBaseUrl),
            textInput("clientBaseUrl", { ltr: true, placeholder: t("common", W.placeholder.clientBaseUrl), maxLength: 500 }),
            t("common", F.clientBaseUrlHint),
            true,
          )}
        <div className="flex flex-col gap-1.5">
          {labeled("ipAddress", t("common", F.ipAddress), textInput("ipAddress", { ltr: true, placeholder: t("common", W.placeholder.ipAddress) }))}
          <AnimatePresence>
            {suggestedIp && suggestedIp !== form.ipAddress.trim() && (
              <motion.button
                type="button"
                initial={reduceMotion ? false : { opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={reduceMotion ? undefined : { opacity: 0, scale: 0.9 }}
                onClick={() => set("ipAddress", suggestedIp)}
                className="inline-flex w-fit items-center gap-1.5 rounded-full border border-[var(--accent-primary)]/40 bg-[var(--leaf-bg)] px-3 py-1 text-[11px] font-bold text-primary hover:brightness-105"
              >
                <Sparkles size={12} aria-hidden />
                <span dir="ltr">{t("common", W.useIp, { ip: suggestedIp })}</span>
              </motion.button>
            )}
          </AnimatePresence>
        </div>
        <BudgetField value={form.maxRequestsPerMinute} onChange={(v) => set("maxRequestsPerMinute", v)} error={errorText("maxRequestsPerMinute")} />
        <Advanced
          forceOpen={Boolean(errors.transport || errors.counterSemantics)}
          title={t("common", W.advanced.title)}
          hint={t("common", W.advanced.hint)}
        >
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-bold text-text-primary">{t("common", F.transport)}</span>
            <ChoiceCards
              name={t("common", F.transport)}
              value={form.transport}
              options={PANEL_TRANSPORTS.map((v) => ({ value: v, title: t("common", R.transport[v]) }))}
              onPick={(v) => set("transport", v)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-bold text-text-primary">{t("common", F.counterSemantics)}</span>
            <ChoiceCards
              name={t("common", F.counterSemantics)}
              value={form.counterSemantics}
              options={COUNTER_SEMANTICS.map((v) => ({ value: v, title: t("common", R.counter[v]) }))}
              onPick={(v) => set("counterSemantics", v)}
            />
            <span className="text-[11px] leading-5 text-text-secondary">{t("common", F.counterSemanticsHint)}</span>
          </div>
        </Advanced>
      </div>
    ),

    login: (
      <div className="flex flex-col gap-4">
        {profile.login === "apiKey" ? (
          labeled("apiKey", t("common", W.login.apiKey), secret("apiKey", parts.apiKey, (v) => setPart("apiKey", v)), t("common", W.login.apiKeyHint))
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {labeled(
              "username",
              t("common", W.login.username),
              <input
                id="rp-username"
                dir="ltr"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                className={`${input} font-mono ${errors.username ? invalidInput : ""}`}
                aria-invalid={Boolean(errors.username)}
                value={parts.username}
                onChange={(e) => setPart("username", e.target.value)}
              />,
            )}
            {labeled("password", t("common", W.login.password), secret("password", parts.password, (v) => setPart("password", v)))}
          </div>
        )}
        {errorText("credentials")}
        {form.transport === "push" &&
          labeled("radiusSecret", t("common", F.radiusSecret), secret("radiusSecret", form.radiusSecret, (v) => set("radiusSecret", v)), t("common", F.radiusSecretHint))}
        <p className="flex items-center gap-1.5 text-[11px] font-bold text-success">
          <ShieldCheck size={14} aria-hidden />
          {t("common", W.login.safe)}
        </p>
      </div>
    ),

    review: <ReviewStep form={form} onEdit={(id) => goTo(REGISTER_STEPS.findIndex((s) => s.id === id))} />,
  };

  const StepIcon = STEP_ICONS[step.id];
  const slide = reduceMotion ? {} : { x: direction * (isRtl ? -28 : 28), opacity: 0 };
  const leave = reduceMotion ? {} : { x: direction * (isRtl ? 28 : -28), opacity: 0 };
  const progress = ((stepIndex + 1) / total) * 100;
  const BackIcon = isRtl ? ArrowRight : ArrowLeft;
  const NextIcon = isRtl ? ArrowLeft : ArrowRight;

  return createPortal(
    <motion.div
      initial={reduceMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/50 backdrop-blur-sm sm:items-center sm:p-4"
      onMouseDown={(e) => e.target === e.currentTarget && requestClose()}
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby="rp-wizard-title"
        initial={reduceMotion ? false : { opacity: 0, y: 28, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: "spring", stiffness: 300, damping: 28 }}
        className="flex h-full w-full flex-col overflow-hidden border-card-border bg-card-bg shadow-2xl sm:h-auto sm:max-h-[92vh] sm:max-w-2xl sm:rounded-3xl sm:border lg:max-w-4xl lg:flex-row"
      >
        {/* Step rail — at the side on lg; below it the progress bar says the same. */}
        <aside className="hidden w-64 shrink-0 flex-col gap-1 border-e border-card-border bg-[var(--bg-inner)] p-5 lg:flex">
          <p className="mb-3 flex items-center gap-2 text-sm font-bold text-text-primary">
            <Server size={16} className="text-primary" aria-hidden />
            {t("common", R.title)}
          </p>
          <ol className="relative flex flex-col gap-1">
            {REGISTER_STEPS.map((s, i) => {
              const Icon = STEP_ICONS[s.id];
              const isDone = i < stepIndex || Boolean(done);
              const current = i === stepIndex && !done;
              const reachable = i <= reached && !done && !saving;
              return (
                <li key={s.id} className="relative">
                  {current && (
                    <motion.span layoutId="rp-rail-current" className="absolute inset-0 rounded-xl bg-card-bg shadow-sm" transition={{ type: "spring", stiffness: 400, damping: 34 }} aria-hidden />
                  )}
                  <button
                    type="button"
                    disabled={!reachable}
                    onClick={() => goTo(i)}
                    aria-current={current ? "step" : undefined}
                    className={`relative flex w-full items-center gap-3 rounded-xl px-2 py-2 text-start transition-colors disabled:cursor-default ${!current && reachable ? "hover:bg-card-bg/60" : ""}`}
                  >
                    <span
                      className={`grid size-8 shrink-0 place-items-center rounded-full border text-xs font-bold transition-colors duration-300 ${
                        isDone
                          ? "border-transparent bg-primary text-white"
                          : current
                            ? "border-[var(--accent-primary)] bg-[var(--leaf-bg)] text-primary"
                            : "border-card-border text-text-secondary"
                      }`}
                    >
                      <AnimatePresence mode="wait" initial={false}>
                        <motion.span
                          key={isDone ? "done" : "icon"}
                          initial={reduceMotion ? false : { scale: 0.3, rotate: -45, opacity: 0 }}
                          animate={{ scale: 1, rotate: 0, opacity: 1 }}
                          exit={reduceMotion ? undefined : { scale: 0.3, opacity: 0 }}
                          transition={{ type: "spring", stiffness: 500, damping: 24 }}
                        >
                          {isDone ? <Check size={14} aria-hidden /> : <Icon size={14} aria-hidden />}
                        </motion.span>
                      </AnimatePresence>
                    </span>
                    <span className="flex flex-col">
                      <span className={`text-xs font-bold ${current || isDone ? "text-text-primary" : "text-text-secondary"}`}>{t("common", W.steps[s.id].title)}</span>
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
              {done ? (
                <span id="rp-wizard-title" className="text-sm font-bold text-text-primary">
                  {t("common", R.title)}
                </span>
              ) : (
                <div className="flex min-w-0 items-center gap-3">
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.span
                      key={step.id}
                      initial={reduceMotion ? false : { scale: 0.6, rotate: -20, opacity: 0 }}
                      animate={{ scale: 1, rotate: 0, opacity: 1 }}
                      exit={reduceMotion ? undefined : { scale: 0.6, opacity: 0 }}
                      transition={{ type: "spring", stiffness: 420, damping: 22 }}
                      className="grid size-10 shrink-0 place-items-center rounded-xl bg-[var(--leaf-bg)] text-primary"
                    >
                      <StepIcon size={20} aria-hidden />
                    </motion.span>
                  </AnimatePresence>
                  <div className="min-w-0">
                    <p className="text-[11px] font-bold text-text-secondary">{t("common", W.stepOf, { current: String(stepIndex + 1), total: String(total) })}</p>
                    <h2 id="rp-wizard-title" className="truncate text-base font-bold text-text-primary">
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
            {!done && (
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--leaf-bg)]" role="progressbar" aria-valuemin={1} aria-valuemax={total} aria-valuenow={stepIndex + 1}>
                <motion.div
                  className="h-full rounded-full bg-primary"
                  animate={{ width: `${progress}%` }}
                  transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 120, damping: 20 }}
                />
              </div>
            )}
          </header>

          <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-5 sm:px-6">
            {done ? (
              <DoneScreen name={done.name} answer={done.answer} onAnother={restart} onFinish={onClose} />
            ) : (
              <AnimatePresence mode="wait" initial={false}>
                <motion.div key={step.id} initial={slide} animate={{ x: 0, opacity: 1 }} exit={leave} transition={{ duration: 0.2, ease: "easeOut" }} className="flex flex-col gap-5">
                  <p className="text-xs text-text-secondary">{t("common", W.steps[step.id].subtitle)}</p>
                  {steps[step.id]}
                  <motion.aside
                    initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: reduceMotion ? 0 : 0.15 }}
                    className="flex items-start gap-3 rounded-2xl border border-dashed border-[var(--accent-primary)]/40 bg-[var(--leaf-bg)] p-3"
                  >
                    <motion.span
                      animate={reduceMotion ? undefined : { rotate: [0, -12, 12, 0] }}
                      transition={{ delay: 0.4, duration: 0.6 }}
                      className="mt-0.5 shrink-0 text-primary"
                    >
                      <Lightbulb size={16} aria-hidden />
                    </motion.span>
                    <p className="text-xs leading-6 text-text-primary">
                      <b>{t("common", W.tip)}: </b>
                      {t("common", W.steps[step.id].tip)}
                    </p>
                  </motion.aside>
                  <AnimatePresence>
                    {failure && (
                      <motion.p
                        role="alert"
                        initial={reduceMotion ? false : { opacity: 0, x: 0 }}
                        animate={reduceMotion ? { opacity: 1 } : { opacity: 1, x: [0, -6, 6, -3, 3, 0] }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.4 }}
                        className="flex items-center gap-2 rounded-xl border border-[var(--error-border)] bg-[var(--error-bg)] p-3 text-xs font-bold text-error"
                      >
                        <TriangleAlert size={14} aria-hidden />
                        {failure}
                      </motion.p>
                    )}
                  </AnimatePresence>
                </motion.div>
              </AnimatePresence>
            )}
          </div>

          {!done && (
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
                  {t("common", R.cancel)}
                </button>
              )}
              {step.id === "review" ? (
                <motion.button
                  type="button"
                  disabled={saving}
                  onClick={() => void submit()}
                  whileTap={reduceMotion ? undefined : { scale: 0.97 }}
                  className="inline-flex min-w-36 items-center justify-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-bold text-white shadow-md transition-all hover:brightness-110 disabled:opacity-60"
                >
                  {saving ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Check size={16} aria-hidden />}
                  {t("common", saving ? W.submitting : W.submit)}
                </motion.button>
              ) : (
                <motion.button
                  type="button"
                  onClick={next}
                  whileTap={reduceMotion ? undefined : { scale: 0.97 }}
                  className="group inline-flex min-w-32 items-center justify-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-bold text-white shadow-md transition-all hover:brightness-110"
                >
                  {t("common", W.next)}
                  <NextIcon size={16} className="transition-transform group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5" aria-hidden />
                </motion.button>
              )}
            </footer>
          )}
        </div>
      </motion.div>
    </motion.div>,
    document.body,
  );
}

function Chip({ children }: { children: ReactNode }) {
  return <span className="rounded-full border border-card-border bg-card-bg px-2 py-0.5 font-bold text-text-primary">{children}</span>;
}

/** Three presets and a custom number; the trade-off is said beside it (contract rule 5). */
function BudgetField({ value, onChange, error }: { value: string; onChange: (v: string) => void; error: ReactNode }) {
  const { t } = useLocale();
  const reduceMotion = useReducedMotion();
  const preset = BUDGET_PRESETS.find((p) => p.value === value.trim());
  const [custom, setCustom] = useState(!preset);
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-card-border bg-[var(--bg-inner)] p-3">
      <span className="flex items-center gap-2 text-xs font-bold text-text-primary">
        <Gauge size={14} className="text-primary" aria-hidden />
        {t("common", SYSTEMS_KEYS.register.field.maxRequestsPerMinute)}
      </span>
      <div role="radiogroup" className="flex flex-wrap gap-1.5">
        {BUDGET_PRESETS.map((p) => {
          const selected = !custom && preset?.value === p.value;
          return (
            <button
              key={p.label}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => {
                setCustom(false);
                onChange(p.value);
              }}
              className={`relative rounded-xl border px-3 py-1.5 text-xs font-bold transition-colors ${selected ? "border-transparent text-white" : "border-card-border text-text-secondary hover:border-[var(--accent-primary)]"}`}
            >
              {selected && <motion.span layoutId="rp-budget" className="absolute inset-0 rounded-xl bg-primary" transition={{ type: "spring", stiffness: 420, damping: 32 }} aria-hidden />}
              <span className="relative">
                {t("common", p.label)} · <span dir="ltr">{p.value || "60"}</span>
              </span>
            </button>
          );
        })}
        <button
          type="button"
          role="radio"
          aria-checked={custom}
          onClick={() => setCustom(true)}
          className={`relative rounded-xl border px-3 py-1.5 text-xs font-bold transition-colors ${custom ? "border-transparent text-white" : "border-card-border text-text-secondary hover:border-[var(--accent-primary)]"}`}
        >
          {custom && <motion.span layoutId="rp-budget" className="absolute inset-0 rounded-xl bg-primary" transition={{ type: "spring", stiffness: 420, damping: 32 }} aria-hidden />}
          <span className="relative">{t("common", W.budget.custom)}</span>
        </button>
      </div>
      <AnimatePresence initial={false}>
        {custom && (
          <motion.div
            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduceMotion ? undefined : { height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <input
              id="rp-maxRequestsPerMinute"
              dir="ltr"
              inputMode="numeric"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              className={`${input} max-w-40 font-mono`}
              aria-label={t("common", SYSTEMS_KEYS.register.field.maxRequestsPerMinute)}
            />
          </motion.div>
        )}
      </AnimatePresence>
      {error}
      <p className="text-[11px] leading-5 text-text-secondary">{t("common", SYSTEMS_KEYS.budget.tradeOff)}</p>
    </div>
  );
}

function Advanced({ title, hint, forceOpen, children }: { title: string; hint: string; forceOpen: boolean; children: ReactNode }) {
  const reduceMotion = useReducedMotion();
  const [open, setOpen] = useState(false);
  const shown = open || forceOpen;
  return (
    <div className="rounded-2xl border border-card-border">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={shown} className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-start">
        <span className="flex flex-col">
          <span className="text-xs font-bold text-text-primary">{title}</span>
          <span className="text-[11px] leading-5 text-text-secondary">{hint}</span>
        </span>
        <motion.span animate={{ rotate: shown ? 180 : 0 }} transition={{ duration: reduceMotion ? 0 : 0.2 }} className="shrink-0 text-text-secondary">
          <ChevronDown size={16} aria-hidden />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {shown && (
          <motion.div
            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduceMotion ? undefined : { height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="flex flex-col gap-4 border-t border-card-border p-3">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ReviewStep({ form, onEdit }: { form: RegisterForm; onEdit: (id: RegisterStepId) => void }) {
  const { t } = useLocale();
  const reduceMotion = useReducedMotion();
  const profile = DRIVER_PROFILES[form.driverType];
  const none = t("common", W.review.none);
  const ltr = (v: string) => (v.trim() ? <span dir="ltr" className="break-all font-mono">{v.trim()}</span> : none);
  const entered = (v: string) =>
    v ? (
      <span className="inline-flex items-center gap-1 text-success">
        <Check size={12} aria-hidden />
        {t("common", W.review.entered)}
      </span>
    ) : (
      <span className="text-text-secondary">{t("common", W.review.notEntered)}</span>
    );

  const sections: [RegisterStepId, [string, ReactNode][]][] = [
    ["family", [[t("common", W.review.family), <span key="d" dir="ltr">{DRIVER_LABELS[form.driverType]}</span>]]],
    [
      "details",
      [
        [t("common", F.name), form.name.trim() || none],
        [t("common", F.region), form.region.trim() || none],
        [t("common", F.role), t("common", W.role[form.role].title)],
      ],
    ],
    [
      "connection",
      [
        [t("common", F.apiBaseUrl), ltr(form.apiBaseUrl)],
        ...(profile.clientBaseUrl && form.transport === "pull" ? ([[t("common", F.clientBaseUrl), ltr(form.clientBaseUrl)]] as [string, ReactNode][]) : []),
        [t("common", F.ipAddress), ltr(form.ipAddress)],
        [t("common", F.maxRequestsPerMinute), form.maxRequestsPerMinute.trim() ? <span dir="ltr">{form.maxRequestsPerMinute.trim()}</span> : t("common", W.review.defaultBudget)],
        [t("common", F.transport), t("common", R.transport[form.transport])],
        [t("common", F.counterSemantics), t("common", R.counter[form.counterSemantics])],
      ],
    ],
    [
      "login",
      [
        [t("common", W.review.login), entered(form.credentials.replace(/^:$/, ""))],
        ...(form.transport === "push" ? ([[t("common", F.radiusSecret), entered(form.radiusSecret)]] as [string, ReactNode][]) : []),
      ],
    ],
  ];

  return (
    <div className="flex flex-col gap-3">
      {sections.map(([id, rows], i) => {
        const Icon = STEP_ICONS[id];
        return (
          <motion.section
            key={id}
            initial={reduceMotion ? false : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: reduceMotion ? 0 : i * 0.06 }}
            className="rounded-2xl border border-card-border bg-[var(--bg-inner)] p-4"
          >
            <div className="mb-2 flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-xs font-bold text-text-primary">
                <Icon size={14} className="text-primary" aria-hidden />
                {t("common", W.steps[id].title)}
              </h3>
              <button type="button" onClick={() => onEdit(id)} className="rounded-lg px-2 py-1 text-[11px] font-bold text-primary hover:bg-card-bg">
                {t("common", W.edit)}
              </button>
            </div>
            <dl className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
              {rows.map(([k, v]) => (
                <div key={k} className="flex items-center justify-between gap-3 text-xs">
                  <dt className="shrink-0 text-text-secondary">{k}</dt>
                  <dd className="min-w-0 text-end font-bold text-text-primary">{v}</dd>
                </div>
              ))}
            </dl>
          </motion.section>
        );
      })}
      {!profile.supported && (
        <p className="flex items-start gap-2 rounded-xl border border-card-border bg-card-bg p-3 text-xs leading-5 text-text-secondary">
          <Clock size={14} className="mt-0.5 shrink-0" aria-hidden />
          {t("common", W.notReadyNote)}
        </p>
      )}
    </div>
  );
}

function DoneScreen({ name, answer, onAnother, onFinish }: { name: string; answer: RegisteredPanel; onAnother: () => void; onFinish: () => void }) {
  const { t } = useLocale();
  const reduceMotion = useReducedMotion();
  const stored = [answer.credentials.configured && R.credentialsStored, answer.radiusSecret?.configured && R.radiusSecretStored].filter(Boolean) as string[];
  return (
    <div className="flex flex-col items-center gap-5 py-6 text-center">
      <div className="relative grid size-24 place-items-center">
        {!reduceMotion &&
          [0, 1].map((i) => (
            <motion.span
              key={i}
              className="absolute inset-0 rounded-full border-2 border-[var(--accent-primary)]"
              initial={{ scale: 0.6, opacity: 0.6 }}
              animate={{ scale: 1.6, opacity: 0 }}
              transition={{ duration: 1.4, delay: 0.25 + i * 0.35, ease: "easeOut" }}
              aria-hidden
            />
          ))}
        <motion.span
          initial={reduceMotion ? false : { scale: 0.3, opacity: 0, rotate: -30 }}
          animate={{ scale: 1, opacity: 1, rotate: 0 }}
          transition={{ type: "spring", stiffness: 260, damping: 16 }}
          className="grid size-20 place-items-center rounded-full bg-[image:var(--card-gradient)] bg-primary text-white shadow-lg"
        >
          <motion.svg viewBox="0 0 24 24" className="size-10" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <motion.path d="M5 12.5l4.5 4.5L19 7.5" initial={reduceMotion ? false : { pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ delay: 0.25, duration: 0.45, ease: "easeOut" }} />
          </motion.svg>
        </motion.span>
      </div>
      <motion.div initial={reduceMotion ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}>
        <h3 className="text-lg font-bold text-text-primary">{t("common", W.done.title, { name })}</h3>
        <p className="mt-1 text-xs text-text-secondary">{t("common", W.done.subtitle)}</p>
      </motion.div>
      <ol className="flex w-full max-w-md flex-col gap-2 text-start">
        {[W.done.step1, W.done.step2, W.done.step3].map((k, i) => (
          <motion.li
            key={k}
            initial={reduceMotion ? false : { opacity: 0, x: 12 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: reduceMotion ? 0 : 0.45 + i * 0.1 }}
            className="flex items-center gap-3 rounded-xl border border-card-border bg-[var(--bg-inner)] p-3 text-xs text-text-primary"
          >
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-[var(--leaf-bg)] text-[11px] font-bold text-primary">{i + 1}</span>
            {t("common", k)}
          </motion.li>
        ))}
      </ol>
      {stored.length > 0 && (
        <p className="flex items-center gap-1.5 text-[11px] font-bold text-success">
          <ShieldCheck size={14} aria-hidden />
          {stored.map((k) => t("common", k)).join(" ")}
        </p>
      )}
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
