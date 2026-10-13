"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CatalogAdminApi, CatalogCapability, CatalogCategory, CatalogProduct } from "@/lib/catalog-api";
import { flattenTexts, type CatalogTexts } from "../_lib/catalog-form";

/** Everything the catalog page lists, read together so no tab shows another moment's state. */
export interface CatalogData {
  categories: CatalogCategory[];
  /** Categories archived with their sold products (F-026-l): out of the tab, still naming those products. */
  archivedCategories: CatalogCategory[];
  /** What a product may unlock (F-114-f-b): the platform's and the caller's own, every one for the owner. */
  capabilities: CatalogCapability[];
  /** Every product the caller manages: the taken keys come from here, whatever the filters show. */
  products: CatalogProduct[];
  /** Sold products a removal kept (F-026-h): out of the list, still holding their keys. */
  archived: CatalogProduct[];
  texts: CatalogTexts;
}

/**
 * The published `catalog` namespace in every language locale-service has —
 * an item falls back to its own source language, which may be any of them
 * (F-1533-g). A failure costs the names, never the list: it shows keys.
 */
async function loadTexts(api: CatalogAdminApi, langs: readonly string[]): Promise<CatalogTexts> {
  const entries = await Promise.all(langs.map(async (l) => [l, flattenTexts(await api.texts(l).catch(() => ({})))] as const));
  return Object.fromEntries(entries);
}

async function readCatalog(api: CatalogAdminApi, langs: readonly string[]): Promise<CatalogData> {
  const [categories, archivedCategories, products, archived, capabilities, texts] = await Promise.all([
    api.categories(),
    api.categories({ archived: "true" }),
    api.products(),
    api.products({ archived: "true" }),
    api.capabilities(),
    loadTexts(api, langs),
  ]);
  return { categories, archivedCategories, products, archived, capabilities, texts };
}

/**
 * The catalog page's data (F-026-f, C-30): the lists, the read's error, and the
 * count of translations waiting for review — a hint beside a link, whose
 * failure is not the page's. Only the newest read writes: an answer for a
 * surface or a language set the page has left is dropped (FE-1-i-a).
 */
export function useCatalogData(api: CatalogAdminApi, langs: readonly string[]) {
  const [data, setData] = useState<CatalogData | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState<number | null>(null);
  const langKey = langs.join(",");
  const latest = useRef(0);

  // Every write is in a promise callback and checks it is still the newest read.
  const read = useCallback(
    (current: () => boolean) => {
      api.translations().then(
        (d) => current() && setPending(d.length),
        () => current() && setPending(null),
      );
      return readCatalog(api, langKey.split(",")).then(
        (next) => {
          if (!current()) return;
          setData(next);
          setError(null);
        },
        (e: unknown) => {
          if (current()) setError(e);
        },
      );
    },
    [api, langKey],
  );

  const reload = useCallback(() => {
    const run = ++latest.current;
    return read(() => run === latest.current);
  }, [read]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, error, pending, reload };
}
