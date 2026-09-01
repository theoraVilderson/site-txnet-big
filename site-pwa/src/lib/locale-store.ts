import "server-only";
import { DEFAULT_LOCALE, LOCALE_SERVICE_ADDR, LOCALE_SCOPE } from "@/env";
import type { CompiledTranslation } from "@/stores/locale-store";
import {
  createLocaleClient,
  type LocaleClient,
} from "@txnet/locale-client";

type Namespace = Record<string, any>;
type LocaleData = Record<string, Record<string, Namespace>>;

/** ساختار فایل metadata.json داخل هر پوشه زبان */
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
 * چطور دیتای زبان لود می‌شود (مهم):
 *
 * کلاینت gRPC (`@txnet/locale-client`) *یک‌بار* موقع `ready()` کل زبان‌ها را
 * می‌گیرد و بعد آن‌ها را با یک استریم Watch زنده نگه می‌دارد. یعنی
 * `client.namespace()` / `client.cached()` فقط از حافظه‌ی همین پروسه می‌خوانند
 * و *هیچ رفت‌وبرگشت gRPC‌ای به‌ازای هر درخواست ندارند*. آپدیت‌ها خودشان از
 * سمت locale-service روی همان استریم می‌آیند و `version` هر زبان را بالا
 * می‌برند.
 *
 * دو هزینه‌ای که این فایل حذف می‌کند:
 *  ۱. بوت اولیه (`initStore`) که قبلاً روی اولین درخواستِ کاربر می‌نشست →
 *     حالا در `src/instrumentation.ts` موقع بالا آمدن سرور گرم می‌شود، و
 *     `ensureReady` دیگر یک درخواست را برای کل مهلتِ بوت بلاک نمی‌کند.
 *  ۲. کامپایلِ متن‌ها (`compileFlat`) که هر رندر تکرار می‌شد → حالا برحسب
 *     `version` هر (زبان، namespace) کش می‌شود و فقط وقتی استریم Watch نسخه
 *     را عوض کند دوباره ساخته می‌شود.
 */

// Next.js در dev هر ماژول را ممکن است چند بار reload کند؛ از global استفاده
// می‌کنیم تا کلاینت gRPC و متادیتا بین reloadها گم نشوند.
const globalForLocale = global as unknown as {
  localeClient: LocaleClient | undefined;
  /** بوتِ single-flight: تا وقتی resolve نشده همه‌ی صداکننده‌ها همین را await می‌کنند */
  localeBoot: Promise<void> | undefined;
  localeMetaMap: Record<string, LocaleMeta> | undefined;
  availableLocales: string[] | undefined;
  /** کش کامپایل: `${lang}:${ns}` → { version, data } */
  compiledCache: Map<
    string,
    { version: string; data: Record<string, CompiledTranslation> }
  > | undefined;
  /** کش unflatten برای API: `${lang}:${ns}` → { version, data } */
  nsCache: Map<string, { version: string; data: Namespace }> | undefined;
};

/** اگر بوت تا این مدت جواب نداد، رندر را با fallback ادامه بده (بوت در پس‌زمینه ادامه دارد) */
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
      node[parts[i]] ??= {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = value;
  }
  return out;
}

/** یک متن خام با {{var}} را به همان فرم توکنی flattenAndCompile تبدیل می‌کند */
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

/** نسخه‌ی فعلیِ یک زبان از کشِ زنده‌ی کلاینت (با هر آپدیت Watch عوض می‌شود) */
function langVersion(lang: string): string {
  return globalForLocale.localeClient?.cached(lang)?.version ?? "?";
}

/**
 * دریافت و کامپایل کردن فقط یک Namespace خاص.
 * نتیجه برحسب version کش می‌شود؛ تا وقتی locale-service آپدیت نفرستد، فقط
 * یک‌بار کامپایل می‌شود و بقیه‌ی درخواست‌ها همان آبجکت را می‌گیرند.
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
 * بوتِ یک‌باره و single-flight. چند صداکننده‌ی همزمان همگی همین یک Promise را
 * می‌گیرند؛ اگر شکست خورد پاک می‌شود تا درخواست بعدی دوباره تلاش کند.
 */
export function initStore(): Promise<void> {
  if (!globalForLocale.localeBoot) {
    globalForLocale.localeBoot = (async () => {
      await client().ready();
      const metaMap = await loadMetaMap();
      globalForLocale.localeMetaMap = metaMap;
      globalForLocale.availableLocales = Object.keys(metaMap);
      console.log("[locale] connected, version:", getVersion());
      if (Object.keys(metaMap).length === 0) {
        // ترجمه‌ها زنده‌اند ولی متادیتا نیامد — بگذار دفعه‌ی بعد دوباره امتحان شود
        throw new Error("locale metadata empty");
      }
    })().catch((e) => {
      globalForLocale.localeBoot = undefined;
      throw e;
    });
  }
  return globalForLocale.localeBoot;
}

export async function reloadStore(): Promise<void> {
  try {
    await client().resync();
    const metaMap = await loadMetaMap();
    globalForLocale.localeMetaMap = metaMap;
    globalForLocale.availableLocales = Object.keys(metaMap);
    // نسخه‌ها عوض شده‌اند؛ کش‌های مشتق را خالی کن تا از نو ساخته شوند
    globalForLocale.compiledCache?.clear();
    globalForLocale.nsCache?.clear();
    console.log("[locale] re-synced, version:", getVersion());
  } catch (e) {
    console.error("[locale] re-sync failed, keeping cached data", e);
  }
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
 * روی مسیرِ درخواست صدا زده می‌شود. اگر استور از قبل گرم است (که با
 * `instrumentation.ts` حالتِ عادی است) بلافاصله برمی‌گردد. اگر هنوز گرم نشده،
 * حداکثر `BOOT_DEADLINE_MS` صبر می‌کند و بعد رندر را با fallback ادامه می‌دهد؛
 * خودِ بوت در پس‌زمینه ادامه دارد و درخواست‌های بعدی دیتای کامل می‌گیرند.
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
