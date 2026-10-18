"use client";

import { useEffect, useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { publishedNamespace } from "@/lib/api-request";
import { flattenTexts } from "../catalog/_lib/catalog-form";

/** The locale-service namespace a package's name and description live in (ADR-0154 (5)). */
const NAMESPACE = "packages";

/** What a reader needs to name a package: the `name` column (the source text) and the key the server derived. */
export type NamedPackage = { name: string; nameKey: string };
/** What a reader needs to describe one; `descriptionKey` is `null` when it has no description. */
export type DescribedPackage = { descriptionKey: string | null; sourceLang: string };

/** Published package texts by language, flat by full key. */
type Texts = Record<string, Record<string, string>>;

/**
 * A package's name and description in the reader's language — the one
 * resolver every page that names a package reads through (ADR-0154 (7)).
 * Falls back to the package's source language (pass the ones on the page as
 * `sourceLangs`), then to the `name` column, which is the source text: a
 * route that fails costs the translation, never the name.
 */
export function usePackageTexts(sourceLangs: readonly string[] = []) {
  const { lang } = useLocale();
  const [texts, setTexts] = useState<Texts>({});
  // A key, not the array: a caller's literal is a new array every render.
  const wanted = [...new Set([lang, ...sourceLangs])].sort().join(",");

  useEffect(() => {
    let alive = true;
    for (const l of wanted.split(",")) {
      publishedIn(l).then((flat) => alive && setTexts((had) => ({ ...had, [l]: flat })));
    }
    return () => {
      alive = false;
    };
  }, [wanted]);

  const text = (key: string | null, langs: string[]) => {
    if (!key) return null;
    for (const l of langs) {
      const v = texts[l]?.[key];
      if (v) return v;
    }
    return null;
  };

  return {
    name: (p: NamedPackage): string => text(p.nameKey, [lang]) ?? p.name,
    description: (p: DescribedPackage): string | null => text(p.descriptionKey, [lang, p.sourceLang]),
  };
}

// The panel's own i18n route, as the catalog's names; offline or the route down, the name column still names it.
async function publishedIn(lang: string): Promise<Record<string, string>> {
  return publishedNamespace(lang, NAMESPACE).then((nested) => flattenTexts(nested, NAMESPACE), () => ({}));
}
