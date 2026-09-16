"use client";

import { ArrowRight, BookOpen, X } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { CATALOG_KEYS as K } from "../_lib/catalog-form";

const STEPS = ["category", "product", "variant", "price", "translations"] as const;

/** Five cards: what each thing on this page is, in the order they are made. */
export function CatalogGuide({ onClose }: { onClose: () => void }) {
  const { t } = useLocale();
  return (
    <section className="rounded-2xl border border-card-border bg-[var(--leaf-bg)] p-4">
      <header className="mb-3 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-bold text-text-primary">
          <BookOpen size={16} className="text-primary" aria-hidden />
          {t("common", K.guide.title)}
        </h2>
        <button type="button" onClick={onClose} aria-label={t("common", K.guide.hide)} className="rounded-lg p-1 text-text-secondary hover:text-text-primary">
          <X size={16} aria-hidden />
        </button>
      </header>
      <ol className="grid gap-2 sm:grid-cols-5">
        {STEPS.map((s, i) => (
          <li key={s} className="relative flex flex-col gap-1 rounded-xl border border-card-border bg-card-bg p-3">
            <p className="text-xs font-bold text-primary">{t("common", K.guide[s].title)}</p>
            <p className="text-[11px] leading-5 text-text-secondary">{t("common", K.guide[s].body)}</p>
            {i < STEPS.length - 1 && <ArrowRight size={14} className="absolute -end-3 top-1/2 hidden text-primary rtl:-scale-x-100 sm:block" aria-hidden />}
          </li>
        ))}
      </ol>
    </section>
  );
}
