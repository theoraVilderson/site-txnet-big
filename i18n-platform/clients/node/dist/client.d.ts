import * as grpc from "@grpc/grpc-js";
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
/** Target of a runtime write: "backend" | "frontend" | "shareds" (not the client's read scope). */
export interface EntryTarget {
    scope: string;
    lang: string;
    namespace: string;
}
export interface DraftEntry extends EntryTarget {
    key: string;
    text: string;
}
export interface DraftFilter {
    scope?: string;
    lang?: string;
    namespace?: string;
    keyPrefix?: string;
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
    /**
     * Runtime writes (F-1533-b, ADR-0050) — straight to locale-service, the cache
     * is untouched (a published write comes back over Watch). `draft: true` holds
     * the text for review, never served. An empty value deletes that key.
     * Resolves to the number of non-empty entries written.
     */
    setEntries(target: EntryTarget & {
        entries: Record<string, string>;
        draft?: boolean;
    }): Promise<number>;
    /** Drafts held for review; every omitted filter matches all. */
    listDrafts(filter?: DraftFilter): Promise<DraftEntry[]>;
    /** Moves the named drafts to published, as they are. Resolves to how many moved. */
    publishDrafts(target: EntryTarget & {
        keys: string[];
    }): Promise<number>;
    close(): void;
}
export declare function createLocaleClient(config: LocaleClientConfig): LocaleClient;
