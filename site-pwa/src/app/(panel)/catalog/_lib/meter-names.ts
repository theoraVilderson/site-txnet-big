"use client";

import { useEffect, useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { catalogApi } from "@/lib/catalog-api";
import { flattenTexts, meterName } from "./catalog-form";

/**
 * Meter names in the viewer's language (F-118-s), for a form that prices a
 * meter — the variant's rate card, the platform's package rates. The
 * `catalog` namespace is the panel's own route whichever tenant the form
 * manages; a failure costs the names, never the form.
 */
export function useMeterNames(): (key: string) => string {
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
  return (key) => meterName(texts, key);
}
