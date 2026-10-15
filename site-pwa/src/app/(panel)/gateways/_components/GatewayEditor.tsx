"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotionConfig } from "framer-motion";
import {
  Building2,
  Check,
  ChevronDown,
  CircleAlert,
  KeyRound,
  Percent,
  RotateCcw,
  SlidersHorizontal,
  TriangleAlert,
  Wallet,
  X,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { ownsAudience, useGatewayMessage, type GatewaySurface } from "../_lib/surface";
import type { Me } from "@/lib/auth-api";
import type { AdminGateway } from "@/lib/billing-api";
import { isManualProvider } from "@/lib/billing/manual-transfer";
import { transferKind } from "../../_components/transfer/transfer-kinds";
import { Select } from "../../_components/kit/Select";
import { formatMoney } from "../../_lib/money";
import { PresetsEditor } from "./PresetsEditor";
import { GatewayAudienceSection } from "./GatewayAudienceSection";
import { FeeFields, Field, PROVIDER_ICONS, TextInput, useRangeText, type SetField } from "./gateway-fields";
import { GatewayConnectionFields } from "./GatewayConnectionFields";
import { useKindText } from "./WizardProviderPicker";
import { Toggle } from "../../_components/kit/Toggle";
import { EDITOR_SECTIONS, FIELD_LABELS, firstInvalidSection, sectionOf, type EditorSectionId } from "../_lib/gateway-editor";
import {
  CATEGORIES,
  PROVIDERS,
  changedFields,
  formFromGateway,
  updateBody,
  validateForm,
  type FormErrors,
  type GatewayForm,
} from "../_lib/gateway-form";
import { PROVIDER_DEFAULTS, type Provider } from "../_lib/gateway-wizard";
import { Button, IconButton, useConfirm } from "../../_components/kit";
import { useOverlayLayer } from "../../_components/kit/overlay";
import { isPlatformTenant } from "@/lib/tenant-type";

const G = FrontendI18nKeys.common.gateways;
const F = G.form;
const W = G.wizard;
const E = G.editor;

const SECTION_ICONS: Record<EditorSectionId, LucideIcon> = {
  general: Building2,
  amounts: Wallet,
  fee: Percent,
  connection: KeyRound,
};

/** A bound worth putting into words: empty (no limit) or a plain decimal. */
const AMOUNT = /^\s*(\d{1,16}(\.\d{1,8})?)?\s*$/;

interface GatewayEditorProps {
  gateway: AdminGateway;
  surface: GatewaySurface;
  me: Me | null;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  /** Its audience was saved (F-102-g): the list re-reads, the editor stays open. */
  onAudienceSaved?: () => void;
}

/**
 * Edit one gateway (F-102-d): every setting on one scrolling screen, grouped
 * as the add wizard walks them, with the section list at the side on `lg` and
 * as tabs above it below `lg`. Both build the same {@link GatewayForm}.
 *
 * - **Save is possible only when something changed**, and the footer names
 *   what: the list is `changedFields`, the keys `updateBody` will send, so what
 *   is shown is exactly what is saved.
 * - **Secrets stay write-only** (`gateway-form.ts`): each box starts empty,
 *   says whether a value is stored, and an empty box keeps it.
 * - A refused save scrolls to the first section with an error. Closing with
 *   unsaved changes asks first; Ctrl/⌘+S saves.
 */
export function GatewayEditor({ gateway, surface, me, onClose, onSaved, onAudienceSaved }: GatewayEditorProps) {
  const { t, lang } = useLocale();
  const confirm = useConfirm();
  const errorMessage = useGatewayMessage(surface);
  const reduceMotion = useReducedMotionConfig();
  const kindText = useKindText();
  const owner = isPlatformTenant(me?.tenant?.type);

  const initial = useMemo(() => formFromGateway(gateway), [gateway]);
  const [form, setForm] = useState<GatewayForm>(initial);
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [showChanges, setShowChanges] = useState(false);
  const [active, setActive] = useState<EditorSectionId>("general");
  const bodyRef = useRef<HTMLDivElement>(null);

  const money = (amount: string) => formatMoney(amount, gateway.currencyCode, { lang, t });
  const rangeText = useRangeText(money);

  const changed = changedFields(gateway, form, me);
  const dirty = changed.length > 0;
  const changedSections = new Set(changed.map(sectionOf));
  const invalid = (Object.keys(errors) as (keyof GatewayForm)[]).filter((k) => errors[k]);
  const errorSections = new Set(invalid.map(sectionOf));

  const set: SetField = (k, v) => {
    setForm((f) => ({ ...f, [k]: v }));
    if (errors[k]) setErrors((e) => ({ ...e, [k]: undefined }));
    setFailure(null);
  };

  const requestClose = async () => {
    if (saving) return;
    if (dirty && !(await confirm({ title: t("common", E.confirmClose), confirmLabel: t("common", E.discard) }))) return;
    onClose();
  };

  const jump = (id: EditorSectionId) => {
    document.getElementById(`gw-section-${id}`)?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    setActive(id);
  };

  const submit = async () => {
    if (saving) return;
    const found = validateForm(form);
    setErrors(found);
    const bad = firstInvalidSection(found);
    if (bad) {
      jump(bad);
      return;
    }
    const body = updateBody(gateway, form, me);
    if (Object.keys(body).length === 0) return;
    setSaving(true);
    setFailure(null);
    try {
      await surface.api.update(gateway.source, gateway.id, body);
      await onSaved();
    } catch (e) {
      setFailure(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    setForm(initial);
    setErrors({});
    setFailure(null);
    setShowChanges(false);
  };

  // The kit's overlay layer (contract.ux.md K7): Esc asks through
  // `requestClose`, Tab stays inside, the page is locked and focus returns.
  const dialogRef = useRef<HTMLDivElement>(null);
  useOverlayLayer({ active: true, containerRef: dialogRef, onClose: () => requestClose() });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (dirty) void submit();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  // The section nearest the top of the scroll area is the one the list marks.
  useEffect(() => {
    const root = bodyRef.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setActive(top.target.id.replace("gw-section-", "") as EditorSectionId);
      },
      { root, rootMargin: "0px 0px -65% 0px" },
    );
    root.querySelectorAll("section[id^='gw-section-']").forEach((s) => observer.observe(s));
    return () => observer.disconnect();
  }, []);

  if (typeof document === "undefined") return null;

  const manual = isManualProvider(form.providerName);
  const provider = form.providerName as Provider | "";
  const ProviderIcon = manual ? transferKind(form.manualKind).icon : (PROVIDER_ICONS[provider as Provider] ?? Building2);
  const rangeReadable = AMOUNT.test(form.minAcceptAmount) && AMOUNT.test(form.maxAcceptAmount) && !errors.minAcceptAmount;

  const chip = (text: string, ok: boolean) => (
    <span className={`rounded-full px-2 py-0.5 text-3xs font-bold ${ok ? "bg-[var(--leaf-bg)] text-success" : "bg-[var(--bg-inner)] text-text-secondary"}`}>{text}</span>
  );

  const navItem = (id: EditorSectionId, compact: boolean) => {
    const Icon = SECTION_ICONS[id];
    const current = active === id;
    const marker = errorSections.has(id) ? (
      <CircleAlert size={14} className="shrink-0 text-error" aria-label={t("common", E.needsAttention)} />
    ) : changedSections.has(id) ? (
      <span className="size-2 shrink-0 rounded-full bg-primary" title={t("common", E.changed)} />
    ) : null;
    if (compact) {
      return (
        <button
          key={id}
          type="button"
          onClick={() => jump(id)}
          aria-current={current ? "true" : undefined}
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-bold transition-colors ${
            current ? "border-[var(--accent-primary)] bg-[var(--leaf-bg)] text-primary" : "border-card-border text-text-secondary"
          }`}
        >
          <Icon size={14} aria-hidden />
          {t("common", E.sections[id].title)}
          {marker}
        </button>
      );
    }
    return (
      <li key={id}>
        <button
          type="button"
          onClick={() => jump(id)}
          aria-current={current ? "true" : undefined}
          className={`flex w-full items-center gap-3 rounded-xl px-2 py-2 text-start transition-colors ${current ? "bg-card-bg shadow-sm" : "hover:bg-card-bg"}`}
        >
          <span
            className={`grid size-8 shrink-0 place-items-center rounded-full border transition-colors ${
              current ? "border-[var(--accent-primary)] bg-[var(--leaf-bg)] text-primary" : "border-card-border text-text-secondary"
            }`}
          >
            <Icon size={14} aria-hidden />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className={`text-xs font-bold ${current ? "text-text-primary" : "text-text-secondary"}`}>{t("common", E.sections[id].title)}</span>
            <span className="line-clamp-1 text-3xs text-text-secondary">{t("common", E.sections[id].subtitle)}</span>
          </span>
          {marker}
        </button>
      </li>
    );
  };

  const sections: Record<EditorSectionId, ReactNode> = {
    general: (
      <div className="grid gap-4 sm:grid-cols-2">
        {gateway.blocked && !owner && (
          <p role="status" className="rounded-xl border border-[var(--error-border)] bg-[var(--error-bg)] p-3 text-sm text-text-primary sm:col-span-2">
            {t("common", G.blockedBecause, { reason: gateway.blocked.reason })}
          </p>
        )}
        <div className="sm:col-span-2">
          <Field id="gw-displayName" label={t("common", F.displayName)} error={errors.displayName} hint={t("common", W.hints.displayName)}>
            <TextInput id="gw-displayName" value={form.displayName} onChange={(v) => set("displayName", v)} invalid={Boolean(errors.displayName)} />
          </Field>
        </div>
        {manual ? (
          // A manual gateway's kind and category are fixed (`manual_setting_mismatch`, `kind_in_use`).
          <p className="text-sm font-bold text-text-primary sm:col-span-2">{kindText(form.manualKind).title}</p>
        ) : (
          <>
        <Field id="gw-providerName" label={t("common", F.provider)} error={errors.providerName}>
          <Select
            value={form.providerName}
            onChange={(v) => set("providerName", v)}
            ariaLabel={t("common", F.provider)}
            invalid={Boolean(errors.providerName)}
            options={PROVIDERS.map((p) => ({ value: p, label: PROVIDER_DEFAULTS[p].name }))}
          />
        </Field>
        <Field id="gw-gatewayCategory" label={t("common", F.category)} error={errors.gatewayCategory}>
          <Select
            value={form.gatewayCategory}
            onChange={(v) => set("gatewayCategory", v)}
            ariaLabel={t("common", F.category)}
            invalid={Boolean(errors.gatewayCategory)}
            options={CATEGORIES.map((c) => ({ value: c, label: t("common", W.categories[c]) }))}
          />
        </Field>
          </>
        )}
        <div className="sm:col-span-2">
          <Toggle checked={form.isActive} onChange={(v) => set("isActive", v)} label={t("common", F.isActive)} hint={t("common", W.hints.isActive)} />
        </div>
        {owner && gateway.source === "tenant" && (
          <div className="sm:col-span-2">
            <Field id="gw-blockedReason" label={t("common", F.blockedReason)} hint={t("common", F.blockedHint)} optional>
              <TextInput id="gw-blockedReason" value={form.blockedReason} onChange={(v) => set("blockedReason", v)} />
            </Field>
          </div>
        )}
      </div>
    ),

    amounts: (
      <div className="flex flex-col gap-5">
        <div className="grid gap-4 sm:grid-cols-2">
          {(["minAcceptAmount", "maxAcceptAmount"] as const).map((k) => (
            <Field key={k} id={`gw-${k}`} label={t("common", k === "minAcceptAmount" ? F.minAmount : F.maxAmount)} error={errors[k]} optional>
              <TextInput
                id={`gw-${k}`}
                value={form[k]}
                onChange={(v) => set(k, v)}
                invalid={Boolean(errors[k])}
                ltr
                decimal
                suffix={gateway.currencyCode}
                placeholder={t("common", G.range.noLimit)}
              />
            </Field>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-[var(--leaf-bg)] px-3 py-2.5 text-xs text-text-primary">
          <SlidersHorizontal size={14} className="shrink-0 text-primary" aria-hidden />
          <span>{t("common", E.accepts)}:</span>
          <b dir="ltr">{rangeReadable ? rangeText(form.minAcceptAmount, form.maxAcceptAmount) : "—"}</b>
          <span className="basis-full text-2xs text-text-secondary">{t("common", E.amountsHint)}</span>
        </div>
        <div className="flex flex-col gap-1.5 border-t border-card-border pt-4">
          <label htmlFor="gw-editor-presets" className="flex items-center gap-2 text-xs font-bold text-text-primary">
            {t("common", G.presets.title)}
            <span className="font-normal text-text-secondary">({t("common", W.optional)})</span>
          </label>
          <p className="text-2xs leading-5 text-text-secondary">{t("common", G.presets.gatewayHint)}</p>
          <PresetsEditor
            id="gw-editor-presets"
            currency={gateway.currencyCode}
            value={form.depositPresets}
            onChange={(next) => set("depositPresets", next)}
            emptyText={t("common", G.presets.inherit)}
          />
        </div>
      </div>
    ),

    fee: <FeeFields form={form} set={set} errors={errors} money={money} currency={gateway.currencyCode} />,

    connection: <GatewayConnectionFields gateway={gateway} form={form} set={set} errors={errors} />,
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/50 backdrop-blur-sm sm:items-center sm:p-4"
      onMouseDown={(e) => e.target === e.currentTarget && requestClose()}
    >
      <motion.div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="gw-editor-title"
        tabIndex={-1}
        initial={reduceMotion ? false : { opacity: 0, y: 24, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.2 }}
        className="flex h-full w-full flex-col overflow-hidden border-card-border bg-card-bg shadow-2xl focus:outline-none sm:h-auto sm:max-h-[92vh] sm:max-w-3xl sm:rounded-3xl sm:border lg:max-w-5xl lg:flex-row"
      >
        {/* Section list — the side rail on lg; tabs in the header below it. */}
        <aside className="hidden w-64 shrink-0 flex-col gap-4 border-e border-card-border bg-[var(--bg-inner)] p-5 lg:flex">
          <p className="text-2xs font-bold text-text-secondary">{t("common", F.editTitle)}</p>
          <ol className="flex flex-col gap-1">{EDITOR_SECTIONS.map((s) => navItem(s.id, false))}</ol>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="shrink-0 border-b border-card-border px-4 pb-3 pt-4 sm:px-6">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-[var(--leaf-bg)] text-primary">
                  <ProviderIcon size={22} aria-hidden />
                </span>
                <div className="min-w-0">
                  <h2 id="gw-editor-title" className="truncate text-base font-bold text-text-primary">
                    {form.displayName.trim() || gateway.displayName}
                  </h2>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    {chip(form.isActive ? t("common", G.active) : t("common", G.inactive), form.isActive)}
                    {chip(gateway.source === "platform" ? t("common", G.platform) : t("common", G.tenant), false)}
                    {gateway.blocked && chip(t("common", G.blocked), false)}
                  </div>
                </div>
              </div>
              <IconButton onClick={requestClose} aria-label={t("common", W.close)} icon={<X size={18} aria-hidden />} />
            </div>
            <nav className="-mx-4 mt-3 flex gap-1.5 overflow-x-auto px-4 pb-0.5 sm:-mx-6 sm:px-6 lg:hidden">
              {EDITOR_SECTIONS.map((s) => navItem(s.id, true))}
            </nav>
          </header>

          <div ref={bodyRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto bg-[var(--bg-inner)] px-4 py-4 sm:px-6 lg:bg-card-bg">
            {EDITOR_SECTIONS.map(({ id }) => {
              const Icon = SECTION_ICONS[id];
              return (
                <section key={id} id={`gw-section-${id}`} className="scroll-mt-4 rounded-2xl border border-card-border bg-card-bg p-4 sm:p-5">
                  <header className="mb-4 flex items-start gap-3">
                    <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-[var(--leaf-bg)] text-primary">
                      <Icon size={18} aria-hidden />
                    </span>
                    <div className="min-w-0">
                      <h3 className="flex items-center gap-2 text-sm font-bold text-text-primary">
                        {t("common", E.sections[id].title)}
                        {changedSections.has(id) && <span className="size-1.5 rounded-full bg-primary" title={t("common", E.changed)} />}
                      </h3>
                      <p className="text-2xs leading-5 text-text-secondary">{t("common", E.sections[id].subtitle)}</p>
                    </div>
                  </header>
                  {sections[id]}
                </section>
              );
            })}
            {/* Its own save, on its own route (F-102-g-e): never part of "what changed". */}
            {ownsAudience(gateway, surface.tenantId, me) && (
              <GatewayAudienceSection gateway={gateway} surface={surface} onSaved={() => onAudienceSaved?.()} />
            )}
            {failure && (
              <p role="alert" className="flex items-center gap-2 rounded-xl border border-[var(--error-border)] bg-[var(--error-bg)] p-3 text-xs font-bold text-error">
                <TriangleAlert size={14} aria-hidden />
                {failure}
              </p>
            )}
          </div>

          <footer className="shrink-0 border-t border-card-border bg-card-bg px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
            <AnimatePresence initial={false}>
              {showChanges && dirty && (
                <motion.div
                  initial={reduceMotion ? false : { height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
                  transition={{ duration: 0.15 }}
                  className="overflow-hidden"
                >
                  <p className="mb-2 text-2xs font-bold text-text-secondary">{t("common", E.changesTitle)}</p>
                  <ul className="mb-3 flex flex-wrap gap-1.5">
                    {changed.map((k) => (
                      <li key={k}>
                        <button
                          type="button"
                          onClick={() => {
                            const s = sectionOf(k);
                            if (s) jump(s);
                          }}
                          className="rounded-full border border-[var(--accent-primary)]/40 bg-[var(--leaf-bg)] px-2.5 py-1 text-2xs font-bold text-primary transition-colors hover:border-[var(--accent-primary)]"
                        >
                          {FIELD_LABELS[k] ? t("common", FIELD_LABELS[k]!) : k}
                        </button>
                      </li>
                    ))}
                  </ul>
                </motion.div>
              )}
            </AnimatePresence>
            <div className="flex items-center justify-between gap-2">
              {invalid.length > 0 ? (
                <p className="flex min-w-0 items-center gap-1.5 text-xs font-bold text-error">
                  <TriangleAlert size={14} className="shrink-0" aria-hidden />
                  <span className="truncate">{t("common", E.needsAttention)}</span>
                </p>
              ) : (
                <Button
                  variant="quiet"
                  size="sm"
                  onClick={() => setShowChanges((v) => !v)}
                  disabled={!dirty}
                  aria-expanded={dirty ? showChanges : undefined}
                  className="min-w-0"
                >
                  <span className={`size-2 shrink-0 rounded-full ${dirty ? "bg-primary" : "bg-card-border"}`} aria-hidden />
                  <span className="truncate">{dirty ? t("common", E.unsaved, { count: String(changed.length) }) : t("common", E.clean)}</span>
                  {dirty && <ChevronDown size={14} className={`shrink-0 transition-transform ${showChanges ? "rotate-180" : ""}`} aria-hidden />}
                </Button>
              )}
              <div className="flex shrink-0 items-center gap-2">
                <Button variant="quiet" onClick={discard} disabled={!dirty || saving} icon={<RotateCcw size={15} aria-hidden />} aria-label={t("common", E.discard)}>
                  <span className="hidden sm:inline">{t("common", E.discard)}</span>
                </Button>
                <Button
                  variant="primary"
                  onClick={() => void submit()}
                  disabled={!dirty}
                  loading={saving}
                  icon={<Check size={16} aria-hidden />}
                  className="min-w-28"
                >
                  {t("common", saving ? F.saving : F.save)}
                </Button>
              </div>
            </div>
          </footer>
        </div>
      </motion.div>
    </div>,
    document.body,
  );
}
