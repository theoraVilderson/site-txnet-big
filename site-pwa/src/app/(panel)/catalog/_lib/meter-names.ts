"use client";

import { useEffect, useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { catalogApi } from "@/lib/catalog-api";
import { flattenTexts, meterName } from "./catalog-form";

/**
 * The published `catalog` namespace in the viewer's language, flat by full
 * key. The panel's own route whichever tenant a page manages; a failure costs
 * the names, never the page — a reader falls back to the item's key.
 */
export function useCatalogTexts(): Record<string, string> {
  const { lang } = useLocale();
  const [texts, setTexts] = useState<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    catalogApi
      .texts(lang)
      .then(flattenTexts)
      .catch(() => ({}))
      .then((flat) => alive && setTexts(flat));
    return () => {
      alive = false;
    };
  }, [lang]);
  return texts;
}

/** Meter names in the viewer's language (F-118-s), for a form that prices a meter — the variant's rate card, the platform's package rates. */
export function useMeterNames(): (key: string) => string {
  const texts = useCatalogTexts();
  return (key) => meterName(texts, key);
}
