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
export declare function createLocaleClient(config: LocaleClientConfig): LocaleClient;
