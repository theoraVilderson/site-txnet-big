"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.createLocaleClient = createLocaleClient;
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
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const grpc = __importStar(require("@grpc/grpc-js"));
const proto_loader_1 = require("@grpc/proto-loader");
const proto_1 = require("./proto");
const VAR_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
function render(raw, vars) {
    if (!raw.includes("{{"))
        return raw;
    return raw.replace(VAR_RE, (m, name) => (vars && name in vars ? String(vars[name]) : m));
}
let cachedCtor;
function serviceCtor() {
    if (cachedCtor)
        return cachedCtor;
    const dir = (0, node_fs_1.mkdtempSync)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "locale-proto-"));
    const file = (0, node_path_1.join)(dir, "locale.proto");
    (0, node_fs_1.writeFileSync)(file, proto_1.LOCALE_PROTO);
    const pkgDef = (0, proto_loader_1.loadSync)(file, {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
    });
    const pkg = grpc.loadPackageDefinition(pkgDef);
    cachedCtor = pkg.locale.v1.LocaleService;
    return cachedCtor;
}
function createLocaleClient(config) {
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
    const cache = new Map();
    let closed = false;
    let readyPromise = null;
    let activeStream = null;
    const replace = (snap) => {
        if (snap && snap.lang)
            cache.set(snap.lang, snap);
    };
    const fetchSnapshot = (lang) => new Promise((resolve, reject) => {
        const deadline = new Date(Date.now() + 5_000);
        stub.GetSnapshot({ lang, scope: config.scope }, { deadline }, (err, res) => err ? reject(err) : resolve(res));
    });
    const fetchLocaleMetas = () => new Promise((resolve, reject) => {
        stub.GetAvailableLocales({}, (err, res) => err ? reject(err) : resolve(res.locales ?? []));
    });
    /** Languages to (pre)load: the configured list, or every advertised locale. */
    async function targetLangs() {
        if (!preloadAll)
            return explicitLangs;
        return (await fetchLocaleMetas()).map((m) => m.code).filter(Boolean);
    }
    async function boot() {
        const deadline = Date.now() + bootTimeoutMs;
        let attempt = 0;
        let lastErr;
        while (Date.now() < deadline) {
            try {
                const langs = await targetLangs();
                if (langs.length === 0)
                    throw new Error("locale-service advertised no languages");
                for (const lang of langs)
                    replace(await fetchSnapshot(lang));
                if (!defaultLang)
                    defaultLang = langs[0];
                return;
            }
            catch (err) {
                lastErr = err;
                attempt++;
                await new Promise((r) => setTimeout(r, Math.min(1000 * attempt, 3000)));
            }
        }
        throw new Error(`[locale] boot failed, locale-service unavailable: ${String(lastErr)}`);
    }
    function startWatch() {
        let backoffMs = 1000;
        const connect = () => {
            if (closed)
                return;
            const stream = stub.Watch({
                langs: explicitLangs, // empty => server streams every language (incl. new ones)
                scope: config.scope,
            });
            activeStream = stream;
            stream.on("data", (ev) => {
                backoffMs = 1000;
                if (ev.full_snapshot) {
                    replace(ev.full_snapshot);
                    log.log(`[locale] updated ${ev.lang}/${ev.scope} -> ${ev.new_version}`);
                }
            });
            const reconnect = async (why) => {
                if (closed)
                    return;
                stream.removeAllListeners();
                log.warn(`[locale] watch disconnected (${why}), retrying in ${backoffMs}ms`);
                await new Promise((r) => setTimeout(r, backoffMs));
                backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
                if (closed)
                    return;
                try {
                    for (const lang of await targetLangs())
                        replace(await fetchSnapshot(lang));
                }
                catch {
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
            if (raw !== undefined)
                return render(raw, vars);
            if (lang !== defaultLang) {
                const fb = cache.get(defaultLang)?.namespaces?.[ns]?.entries?.[key];
                if (fb !== undefined)
                    return render(fb, vars);
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
            for (const lang of await targetLangs())
                replace(await fetchSnapshot(lang));
        },
        languages() {
            const seen = new Set();
            const out = [];
            for (const l of explicitLangs)
                if (cache.has(l) && !seen.has(l))
                    (seen.add(l), out.push(l));
            const rest = [...cache.keys()].filter((l) => !seen.has(l)).sort();
            return out.concat(rest);
        },
        defaultLang() {
            return defaultLang;
        },
        resolveLanguage(acceptLanguage) {
            const available = this.languages();
            if (!acceptLanguage)
                return defaultLang;
            for (const part of acceptLanguage.split(",")) {
                const code = part.trim().split(";")[0];
                if (!code)
                    continue;
                const full = code.toLowerCase();
                const base = full.split("-")[0];
                if (available.includes(full))
                    return full;
                if (available.includes(base))
                    return base;
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
                stub.close?.();
            }
            catch {
                /* noop */
            }
        },
    };
}
