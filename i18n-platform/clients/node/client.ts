/**
 * Canonical Node/TypeScript client for locale-service.
 *
 * NOT a shared package. Every Node service vendors a copy of this directory
 * (client.ts + proto.ts) under its own tree. See i18n-platform/README.md.
 *
 * Behaviour contract (identical to the Go client):
 *   - ready() blocks until the first GetSnapshot for every preload language
 *     succeeds or bootTimeoutMs elapses (then it rejects — fail fast).
 *   - The in-memory cache is replaced atomically per language — never merged.
 *   - A background Watch stream keeps the cache fresh; on disconnect it
 *     reconnects with exponential backoff and re-fetches a fresh snapshot.
 *   - A missing key returns the key itself; translation never throws.
 *
 * Requires: @grpc/grpc-js, @grpc/proto-loader  (server-side only).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as grpc from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import { LOCALE_PROTO } from "./proto";

export interface NamespaceData {
  entries: Record<string, string>;
}
export interface SnapshotResponse {
  lang: string;
  scope: string;
  version: string;
  namespaces: Record<string, NamespaceData>;
}
export interface LocaleMeta {
  code: string;
  name: string;
  short_name: string;
  native_name: string;
  dir: "rtl" | "ltr" | string;
  locale: string;
}
export interface UpdateEvent {
  lang: string;
  scope: string;
  new_version: string;
  full_snapshot: SnapshotResponse;
}

export interface LocaleClientConfig {
  /** locale-service gRPC address, e.g. "localhost:50051". */
  addr: string;
  /** "backend" | "frontend" | "" (every scope, namespace keys "<scope>/..."). */
  scope: string;
  /**
   * Fetched (blocking) by ready() and kept live by Watch. Omit / leave empty to
   * load EVERY language locale-service advertises (new languages are then picked
   * up automatically over the Watch stream).
   */
  preloadLangs?: string[];
  /** Fallback language for translate(). Defaults to the first loaded language. */
  defaultLang?: string;
  /** Caps the blocking boot. Default 10_000. */
  bootTimeoutMs?: number;
  /** Caps the Watch reconnect backoff. Default 30_000. */
  maxBackoffMs?: number;
  /** Extra channel credentials; defaults to insecure. */
  credentials?: grpc.ChannelCredentials;
  /** Optional structured logger. */
  logger?: Pick<Console, "log" | "warn" | "error">;
}

export interface LocaleClient {
  ready(): Promise<void>;
  t(lang: string, namespace: string, key: string, vars?: Record<string, string | number>): string;
  translate(lang: string, namespace: string, key: string): string;
  namespace(lang: string, namespace: string): Record<string, string> | undefined;
  /** The whole cached snapshot for a language (namespaces + flat entries). */
  cached(lang: string): SnapshotResponse | undefined;
  /** Force a fresh GetSnapshot for every preload language (Watch already keeps it live). */
  resync(): Promise<void>;
  languages(): string[];
  defaultLang(): string;
  resolveLanguage(acceptLanguage?: string): string;
  availableLocales(): Promise<LocaleMeta[]>;
  snapshot(lang: string): Promise<SnapshotResponse>;
  close(): void;
}

const VAR_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

function render(raw: string, vars?: Record<string, string | number>): string {
  if (!raw.includes("{{")) return raw;
  return raw.replace(VAR_RE, (m, name) => (vars && name in vars ? String(vars[name]) : m));
}

let cachedCtor: any;
function serviceCtor(): any {
  if (cachedCtor) return cachedCtor;
  const dir = mkdtempSync(join(tmpdir(), "locale-proto-"));
  const file = join(dir, "locale.proto");
  writeFileSync(file, LOCALE_PROTO);
  const pkgDef = loadSync(file, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const pkg = grpc.loadPackageDefinition(pkgDef) as any;
  cachedCtor = pkg.locale.v1.LocaleService;
  return cachedCtor;
}

export function createLocaleClient(config: LocaleClientConfig): LocaleClient {
  const log = config.logger ?? console;
  const bootTimeoutMs = config.bootTimeoutMs ?? 10_000;
  const maxBackoffMs = config.maxBackoffMs ?? 30_000;
  const explicitLangs = config.preloadLangs ?? [];
  const preloadAll = explicitLangs.length === 0;
  let defaultLang = config.defaultLang ?? explicitLangs[0] ?? "";

  const Ctor = serviceCtor();
  // locale-service is always an internal service — never route it through an
  // HTTP(S)_PROXY picked up from the environment (grpc-js does this by default,
  // and NO_PROXY only matches hostnames/CIDRs, not a bare service name).
  const stub = new Ctor(config.addr, config.credentials ?? grpc.credentials.createInsecure(), {
    "grpc.enable_http_proxy": 0,
  });

  const cache = new Map<string, SnapshotResponse>();
  let closed = false;
  let readyPromise: Promise<void> | null = null;
  let activeStream: grpc.ClientReadableStream<UpdateEvent> | null = null;

  const replace = (snap: SnapshotResponse) => {
    if (snap && snap.lang) cache.set(snap.lang, snap);
  };

  const fetchSnapshot = (lang: string): Promise<SnapshotResponse> =>
    new Promise((resolve, reject) => {
      const deadline = new Date(Date.now() + 5_000);
      stub.GetSnapshot({ lang, scope: config.scope }, { deadline }, (err: unknown, res: SnapshotResponse) =>
        err ? reject(err) : resolve(res),
      );
    });

  const fetchLocaleMetas = (): Promise<LocaleMeta[]> =>
    new Promise((resolve, reject) => {
      stub.GetAvailableLocales({}, (err: unknown, res: { locales?: LocaleMeta[] }) =>
        err ? reject(err) : resolve(res.locales ?? []),
      );
    });

  /** Languages to (pre)load: the configured list, or every advertised locale. */
  async function targetLangs(): Promise<string[]> {
    if (!preloadAll) return explicitLangs;
    return (await fetchLocaleMetas()).map((m) => m.code).filter(Boolean);
  }

  async function boot(): Promise<void> {
    const deadline = Date.now() + bootTimeoutMs;
    let attempt = 0;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      try {
        const langs = await targetLangs();
        if (langs.length === 0) throw new Error("locale-service advertised no languages");
        for (const lang of langs) replace(await fetchSnapshot(lang));
        if (!defaultLang) defaultLang = langs[0];
        return;
      } catch (err) {
        lastErr = err;
        attempt++;
        await new Promise((r) => setTimeout(r, Math.min(1000 * attempt, 3000)));
      }
    }
    throw new Error(`[locale] boot failed, locale-service unavailable: ${String(lastErr)}`);
  }

  function startWatch(): void {
    let backoffMs = 1000;

    const connect = () => {
      if (closed) return;
      const stream: grpc.ClientReadableStream<UpdateEvent> = stub.Watch({
        langs: explicitLangs, // empty => server streams every language (incl. new ones)
        scope: config.scope,
      });
      activeStream = stream;

      stream.on("data", (ev: UpdateEvent) => {
        backoffMs = 1000;
        if (ev.full_snapshot) {
          replace(ev.full_snapshot);
          log.log(`[locale] updated ${ev.lang}/${ev.scope} -> ${ev.new_version}`);
        }
      });
      const reconnect = async (why: string) => {
        if (closed) return;
        stream.removeAllListeners();
        log.warn(`[locale] watch disconnected (${why}), retrying in ${backoffMs}ms`);
        await new Promise((r) => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
        if (closed) return;
        try {
          for (const lang of await targetLangs()) replace(await fetchSnapshot(lang));
        } catch {
          /* connect() will retry */
        }
        connect();
      };
      stream.on("error", (err) => reconnect(String(err)));
      stream.on("end", () => reconnect("stream end"));
    };

    connect();
  }

  return {
    ready() {
      if (!readyPromise) {
        readyPromise = boot()
          .then(startWatch)
          .catch((err) => {
            readyPromise = null; // a failed boot must not be cached forever — let the next call retry
            throw err;
          });
      }
      return readyPromise;
    },

    t(lang, ns, key, vars) {
      const raw = cache.get(lang)?.namespaces?.[ns]?.entries?.[key];
      if (raw !== undefined) return render(raw, vars);
      if (lang !== defaultLang) {
        const fb = cache.get(defaultLang)?.namespaces?.[ns]?.entries?.[key];
        if (fb !== undefined) return render(fb, vars);
      }
      return key;
    },

    translate(lang, ns, key) {
      return this.t(lang, ns, key);
    },

    namespace(lang, ns) {
      const entries = cache.get(lang)?.namespaces?.[ns]?.entries;
      return entries ? { ...entries } : undefined;
    },

    cached(lang) {
      return cache.get(lang);
    },

    async resync() {
      for (const lang of await targetLangs()) replace(await fetchSnapshot(lang));
    },

    languages() {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const l of explicitLangs) if (cache.has(l) && !seen.has(l)) (seen.add(l), out.push(l));
      const rest = [...cache.keys()].filter((l) => !seen.has(l)).sort();
      return out.concat(rest);
    },

    defaultLang() {
      return defaultLang;
    },

    resolveLanguage(acceptLanguage) {
      const available = this.languages();
      if (!acceptLanguage) return defaultLang;
      for (const part of acceptLanguage.split(",")) {
        const code = part.trim().split(";")[0];
        if (!code) continue;
        const full = code.toLowerCase();
        const base = full.split("-")[0];
        if (available.includes(full)) return full;
        if (available.includes(base)) return base;
      }
      return defaultLang;
    },

    availableLocales() {
      return fetchLocaleMetas();
    },

    snapshot(lang) {
      return fetchSnapshot(lang);
    },

    close() {
      closed = true;
      activeStream?.cancel();
      try {
        (stub as { close?: () => void }).close?.();
      } catch {
        /* noop */
      }
    },
  };
}
