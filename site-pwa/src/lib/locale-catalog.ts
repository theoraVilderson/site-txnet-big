import "server-only";
import { DEFAULT_LOCALE, LOCALE_SERVICE_ADDR, LOCALE_SCOPE } from "@/env";
import type { CompiledTranslation } from "@/stores/locale-store";
import {
  createLocaleClient,
  type LocaleClient,
} from "@txnet/locale-client";

/** The raw translation tree: every leaf a string, every branch a nested Namespace. */
type Namespace = { [key: string]: string | Namespace };
type LocaleData = Record<string, Record<string, Namespace>>;

/** The shape of each language folder's metadata.json. */
export interface LocaleMeta {
  code: string;
  name: string;
  shortName: string;
  englishName: string;
  nativeName: string;
  dir: "rtl" | "ltr";
  locale: string;
}

/**
 * How the language data loads (important):
 *
 * The gRPC client (`@txnet/locale-client`) fetches every language *once*, on
 * `ready()`, then keeps them live over a Watch stream. So
 * `client.namespace()` / `client.cached()` read this process's memory only,
 * with *no gRPC round trip per request*. Updates arrive from locale-service on
 * the same stream and bump each language's `version`.
 *
 * Two costs this file removes:
 *  1. The initial boot (`initStore`), which used to sit on the first visitor's
 *     request -> now warmed in `src/instrumentation.ts` at server start, and
 *     `ensureReady` no longer blocks a request for the whole boot deadline.
 *  2. Compiling the texts (`compileFlat`), once repeated on every render ->
 *     now cached per (language, namespace) `version` and rebuilt only when
 *     the Watch stream changes that version.
 */

// In dev Next.js may reload a module many times; state lives on `global` so
// the gRPC client and metadata survive the reloads.
const globalForLocale = global as unknown as {
  localeClient: LocaleClient | undefined;
  /** Single-flight boot: until it resolves every caller awaits this one. */
  localeBoot: Promise<void> | undefined;
  localeMetaMap: Record<string, LocaleMeta> | undefined;
  availableLocales: string[] | undefined;
  /** Compile cache: `${lang}:${ns}` → { version, data } */
  compiledCache: Map<
    string,
    { version: string; data: Record<string, CompiledTranslation> }
  > | undefined;
  /** Unflatten cache for the API: `${lang}:${ns}` → { version, data } */
  nsCache: Map<string, { version: string; data: Namespace }> | undefined;
};

/** Past this, render with the fallback; the boot carries on in the background. */
const BOOT_DEADLINE_MS = 3_000;

function client(): LocaleClient {
  if (!globalForLocale.localeClient) {
    // no preloadLangs → load every language locale-service advertises
    globalForLocale.localeClient = createLocaleClient({
      addr: LOCALE_SERVICE_ADDR,
      scope: LOCALE_SCOPE,
      defaultLang: DEFAULT_LOCALE,
      bootTimeoutMs: 10_000,
    });
  }
  return globalForLocale.localeClient;
}

/** {"a.b":"x"} -> {a:{b:"x"}} */
function unflatten(flat: Record<string, string>): Namespace {
  const out: Namespace = {};
  for (const [path, value] of Object.entries(flat)) {
    const parts = path.split(".");
    let node = out;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = node[parts[i]];
      if (typeof next !== "object") {
        next = {};
        node[parts[i]] = next;
      }
      node = next;
    }
    node[parts[parts.length - 1]] = value;
  }
  return out;
}

/** A raw text with {{var}} into the same token form flattenAndCompile makes. */
function compileValue(text: string): CompiledTranslation {
  return text.includes("{{")
    ? text.split(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)
    : text;
}

function compileFlat(
  flat: Record<string, string>,
): Record<string, CompiledTranslation> {
  const out: Record<string, CompiledTranslation> = {};
  for (const [k, v] of Object.entries(flat)) out[k] = compileValue(v);
  return out;
}

/** A language's current version in the client's live cache (changes on every Watch update). */
function langVersion(lang: string): string {
  return globalForLocale.localeClient?.cached(lang)?.version ?? "?";
}

/**
 * One namespace, fetched and compiled. Cached by version: until locale-service
 * sends an update it is compiled once and every request gets the same object.
 */
export function getCompiledNamespace(
  lang: string,
  ns: string,
): Record<string, CompiledTranslation> {
  const c = globalForLocale.localeClient;
  if (!c) return {};

  const version = langVersion(lang);
  const key = `${lang}:${ns}`;
  const cache = (globalForLocale.compiledCache ??= new Map());

  const hit = cache.get(key);
  if (hit && hit.version === version) return hit.data;

  const flat = c.namespace(lang, ns);
  const data = flat ? compileFlat(flat) : {};
  cache.set(key, { version, data });
  return data;
}

async function loadMetaMap(): Promise<Record<string, LocaleMeta>> {
  const metaMap: Record<string, LocaleMeta> = {};
  try {
    for (const m of await client().availableLocales()) {
      metaMap[m.code] = {
        code: m.code,
        name: m.name,
        shortName: m.short_name,
        englishName: m.name,
        nativeName: m.native_name,
        dir: m.dir === "rtl" ? "rtl" : "ltr",
        locale: m.locale,
      };
    }
  } catch (e) {
    console.error("[locale] could not fetch locale metadata", e);
  }
  return metaMap;
}

/**
 * One single-flight boot. Concurrent callers all get this one Promise; a
 * failure clears it so the next request tries again.
 */
export function initStore(): Promise<void> {
  if (!globalForLocale.localeBoot) {
    globalForLocale.localeBoot = (async () => {
      await client().ready();
      const metaMap = await loadMetaMap();
      globalForLocale.localeMetaMap = metaMap;
      globalForLocale.availableLocales = Object.keys(metaMap);
      console.info("[locale] connected, version:", getVersion());
      if (Object.keys(metaMap).length === 0) {
        // Translations are live but metadata did not come — let the next call retry.
        throw new Error("locale metadata empty");
      }
    })().catch((e) => {
      globalForLocale.localeBoot = undefined;
      throw e;
    });
  }
  return globalForLocale.localeBoot;
}

export function getNamespace(lang: string, ns: string): Namespace | undefined {
  const c = globalForLocale.localeClient;
  if (!c) return undefined;

  const version = langVersion(lang);
  const key = `${lang}:${ns}`;
  const cache = (globalForLocale.nsCache ??= new Map());

  const hit = cache.get(key);
  if (hit && hit.version === version) return hit.data;

  const flat = c.namespace(lang, ns);
  if (!flat) return undefined;
  const data = unflatten(flat);
  cache.set(key, { version, data });
  return data;
}

export function getStore(): LocaleData {
  const out: LocaleData = {};
  const c = globalForLocale.localeClient;
  if (!c) return out;
  for (const lang of c.languages()) {
    const snap = c.cached(lang);
    if (!snap) continue;
    out[lang] = {};
    for (const [ns, data] of Object.entries(snap.namespaces)) {
      out[lang][ns] = unflatten(data.entries);
    }
  }
  return out;
}

export function getVersion(): string {
  const c = globalForLocale.localeClient;
  if (!c) return "unknown";
  return c
    .languages()
    .map((l) => `${l}:${c.cached(l)?.version ?? "?"}`)
    .join("|");
}

export function isInitialized(): boolean {
  return !!globalForLocale.localeMetaMap;
}

/**
 * Called on the request path. Returns at once when the catalog is warm (the
 * normal case, thanks to `instrumentation.ts`). Otherwise waits at most
 * `BOOT_DEADLINE_MS` and lets rendering continue with the fallback; the boot
 * carries on in the background and later requests get the full data.
 */
export async function ensureReady(
  startWatching: () => Promise<void>,
): Promise<void> {
  if (isInitialized()) return;

  try {
    await Promise.race([
      (async () => {
        await initStore();
        await startWatching();
      })(),
      new Promise<void>((_, reject) =>
        setTimeout(
          () => reject(new Error("locale boot deadline exceeded")),
          BOOT_DEADLINE_MS,
        ),
      ),
    ]);
  } catch (e) {
    console.error(
      "[locale] not ready on request path — rendering with fallback",
      e,
    );
  }
}

export function getLocaleMeta(lang: string): LocaleMeta | undefined {
  return globalForLocale.localeMetaMap?.[lang];
}

export function getAvailableLocales(): string[] {
  return globalForLocale.availableLocales ?? [];
}

export function getDir(lang: string): "rtl" | "ltr" {
  return getLocaleMeta(lang)?.dir ?? "ltr";
}
