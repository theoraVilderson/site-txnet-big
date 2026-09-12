"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, Filter, Search, X } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
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

  const field =
    "w-full rounded-xl border border-card-border bg-bg-inner px-3 py-2.5 text-sm text-text-primary outline-none focus:border-primary";
  const label = "mb-1.5 block text-xs font-medium text-text-secondary";

  return (
    <div className="relative z-20 mb-6">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`relative flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-medium transition-all ${
          open
            ? "bg-primary text-white shadow-lg shadow-primary-glow"
            : "border border-card-border bg-card-bg text-text-primary hover:bg-leaf-bg"
        }`}
      >
        <Filter size={18} aria-hidden />
        <span>{t("common", open ? F.filter.close : F.filter.open)}</span>
        {open ? (
          <X size={16} aria-hidden />
        ) : (
          hasNarrowingFilter(filters) && (
            <span
              title={t("common", F.filter.active)}
              className="absolute end-1.5 top-1.5 h-2 w-2 animate-pulse rounded-full bg-error"
            >
              <span className="sr-only">{t("common", F.filter.active)}</span>
            </span>
          )
        )}
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            <div className="mt-3 rounded-2xl border border-card-border bg-card-bg p-5 shadow-xl md:p-6">
              <div className="grid grid-cols-1 gap-5 md:grid-cols-4">
                {filters.tab === "ledger" && (
                  <>
                    <div className="md:col-span-4">
                      <label className={label} htmlFor="financial-search">
                        {t("common", F.filter.search)}
                      </label>
                      <div className="relative">
                        <input
                          id="financial-search"
                          type="text"
                          value={draft.search}
                          onChange={(e) => set("search", e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && apply()}
                          placeholder={t("common", F.filter.searchPlaceholder)}
                          className={`${field} ps-10`}
                        />
                        <Search
                          size={18}
                          aria-hidden
                          className="pointer-events-none absolute inset-y-0 start-3 my-auto text-text-secondary"
                        />
                      </div>
                    </div>

                    <div>
                      <label className={label} htmlFor="financial-type">
                        {t("common", F.filter.type)}
                      </label>
                      <select
                        id="financial-type"
                        value={draft.types[0] ?? ""}
                        onChange={(e) =>
                          set("types", e.target.value ? [e.target.value as ReasonType] : [])
                        }
                        className={field}
                      >
                        <option value="">{t("common", F.filter.all)}</option>
                        {REASON_TYPES.map((type) => {
                          const key = reasonLabelKey(type);
                          return (
                            <option key={type} value={type}>
                              {key ? t("common", key) : type}
                            </option>
                          );
                        })}
                      </select>
                    </div>

                    <div>
                      <label className={label} htmlFor="financial-direction">
                        {t("common", F.filter.direction)}
                      </label>
                      <select
                        id="financial-direction"
                        value={draft.direction ?? ""}
                        onChange={(e) => set("direction", (e.target.value || null) as Direction | null)}
                        className={field}
                      >
                        <option value="">{t("common", F.filter.all)}</option>
                        {DIRECTIONS.map((d) => (
                          <option key={d} value={d}>
                            {t("common", F.direction[d])}
                          </option>
                        ))}
                      </select>
                    </div>
                  </>
                )}

                {filters.tab === "payments" && (
                  <div className="md:col-span-2">
                    <label className={label} htmlFor="financial-status">
                      {t("common", F.filter.status)}
                    </label>
                    <select
                      id="financial-status"
                      value={draft.statuses[0] ?? ""}
                      onChange={(e) =>
                        set("statuses", e.target.value ? [e.target.value as PaymentStatus] : [])
                      }
                      className={field}
                    >
                      <option value="">{t("common", F.filter.all)}</option>
                      {PAYMENT_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {t("common", F.status[s])}
                        </option>
                      ))}
                    </select>
                  </div>
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
                <button
                  type="button"
                  onClick={reset}
                  className="rounded-lg px-5 py-2 text-sm text-text-secondary transition-colors hover:bg-leaf-bg"
                >
                  {t("common", F.filter.reset)}
                </button>
                <button
                  type="button"
                  onClick={apply}
                  className="flex items-center gap-2 rounded-lg bg-primary px-5 py-2 text-sm font-medium text-white shadow-lg shadow-primary-glow transition-transform hover:scale-105"
                >
                  <CheckCircle2 size={16} aria-hidden />
                  {t("common", F.filter.apply)}
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
