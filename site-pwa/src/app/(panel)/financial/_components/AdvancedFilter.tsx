"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, Filter, Search, X } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { Button, Card, Field, Input, Select } from "../../_components/kit";
import { DatePicker } from "../../_components/kit/DatePicker";
import {
  DIRECTIONS,
  EMPTY_FILTERS,
  PAYMENT_STATUSES,
  REASON_TYPES,
  hasNarrowingFilter,
  type Direction,
  type FinancialFilters,
  type PaymentStatus,
  type ReasonType,
} from "../_lib/filters";
import { reasonLabelKey } from "../_lib/tones";

const F = FrontendI18nKeys.common.financial;

export interface AdvancedFilterProps {
  filters: FinancialFilters;
  /** Applied as one change, not per keystroke — see below. */
  onApply: (next: FinancialFilters) => void;
}

/**
 * The filter panel (F-093-d).
 *
 * **It edits a draft and applies it once.** Every field here costs a request
 * and the routes are rate-limited per user (`WALLET_HISTORY_RATE_LIMIT`), so a
 * filter that fired on each keystroke would spend a 15-minute budget on one
 * search term. Apply and reset are the only two things that touch the URL.
 *
 * Which fields are shown follows the open tab, because the two lists take
 * different filters: a ledger row has a reason type and a direction, a payment
 * attempt has a status. Offering all of them on both tabs is how a `statuses`
 * filter ends up in a ledger query.
 */
export function AdvancedFilter({ filters, onApply }: AdvancedFilterProps) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(filters);

  // A back button, a reset, or a tab change moves the real filters under the
  // panel; the draft follows them rather than re-applying what was typed last.
  // Adjusted during the render that sees the change, not in an effect after it
  // — an effect would show one frame of the old draft over the new list.
  const [applied, setApplied] = useState(filters);
  if (applied !== filters) {
    setApplied(filters);
    setDraft(filters);
  }

  const set = <K extends keyof FinancialFilters>(key: K, value: FinancialFilters[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const apply = () => {
    onApply(draft);
    setOpen(false);
  };

  const reset = () => {
    onApply({ ...EMPTY_FILTERS, tab: filters.tab });
    setOpen(false);
  };

  const all = { value: "", label: t("common", F.filter.all) };

  return (
    <div className="relative z-20 mb-6">
      <Button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        variant={open ? "primary" : "secondary"}
        icon={<Filter size={18} aria-hidden />}
        iconEnd={open ? <X size={16} aria-hidden /> : undefined}
      >
        {t("common", open ? F.filter.close : F.filter.open)}
        {!open && hasNarrowingFilter(filters) && (
          <span
            title={t("common", F.filter.active)}
            className="absolute end-1.5 top-1.5 h-2 w-2 animate-pulse rounded-full bg-error"
          >
            <span className="sr-only">{t("common", F.filter.active)}</span>
          </span>
        )}
      </Button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            <Card padding="lg" className="mt-3">
              <div className="grid grid-cols-1 gap-5 md:grid-cols-4">
                {filters.tab === "ledger" && (
                  <>
                    <Field label={t("common", F.filter.search)} className="md:col-span-4">
                      <Input
                        type="text"
                        value={draft.search}
                        onChange={(e) => set("search", e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && apply()}
                        placeholder={t("common", F.filter.searchPlaceholder)}
                        end={<Search size={18} aria-hidden className="pointer-events-none me-1.5 text-text-secondary" />}
                      />
                    </Field>

                    <Field label={t("common", F.filter.type)} optional>
                      <Select
                        value={draft.types[0] ?? ""}
                        onChange={(v) => set("types", v ? [v as ReasonType] : [])}
                        options={[
                          all,
                          ...REASON_TYPES.map((type) => {
                            const key = reasonLabelKey(type);
                            return { value: type, label: key ? t("common", key) : type };
                          }),
                        ]}
                      />
                    </Field>

                    <Field label={t("common", F.filter.direction)} optional>
                      <Select
                        value={draft.direction ?? ""}
                        onChange={(v) => set("direction", (v || null) as Direction | null)}
                        options={[all, ...DIRECTIONS.map((d) => ({ value: d, label: t("common", F.direction[d]) }))]}
                      />
                    </Field>
                  </>
                )}

                {filters.tab === "payments" && (
                  <Field label={t("common", F.filter.status)} className="md:col-span-2">
                    <Select
                      value={draft.statuses[0] ?? ""}
                      onChange={(v) => set("statuses", v ? [v as PaymentStatus] : [])}
                      options={[all, ...PAYMENT_STATUSES.map((st) => ({ value: st, label: t("common", F.status[st]) }))]}
                    />
                  </Field>
                )}

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:col-span-2">
                  <DatePicker
                    label={t("common", F.filter.from)}
                    value={draft.from}
                    onChange={(value) => set("from", value)}
                  />
                  <DatePicker
                    label={t("common", F.filter.to)}
                    value={draft.to}
                    onChange={(value) => set("to", value)}
                  />
                </div>
              </div>

              <div className="mt-6 flex justify-end gap-3 border-t border-card-border pt-4">
                <Button variant="quiet" onClick={reset}>
                  {t("common", F.filter.reset)}
                </Button>
                <Button variant="primary" icon={<CheckCircle2 size={16} aria-hidden />} onClick={apply}>
                  {t("common", F.filter.apply)}
                </Button>
              </div>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
