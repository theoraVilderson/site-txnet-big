// The panel's one door to browser storage (FE-1-l, C-27). Storage is a
// per-viewer convenience here, never a record: it can be missing (server
// render), blocked (a private window, cleared site data) or full, and every
// caller wants the same answer then — "nothing kept" — so the try/catch lives
// once, here, instead of in each of the nine places that used to repeat it.
import type { ZodType } from "zod";

type Area = "local" | "session";

/** A stored value's address: which storage, and under which name. */
export type StorageKey = { readonly area: Area; readonly key: string };

/**
 * Every key the panel keeps, in one registry, so two features never share a
 * name by accident and a key is renamed in one place. `session` is one tab's
 * (a trip to the bank, a sign-in redirect); `local` outlives it.
 */
export const StorageKeys = {
  catalogGuideClosed: { area: "local", key: "txnet.catalog.guideClosed" },
  systemsGuideClosed: { area: "local", key: "txnet.systems.guideClosed" },
  recentPages: { area: "local", key: "txnet.panel.recentPages" },
  supportPresence: { area: "local", key: "txnet.support.presence" },
  displayZone: { area: "local", key: "txnet.displayZone" },
  shopReturnInvoice: { area: "session", key: "txnet.shop.returnInvoice" },
  miniAppMarker: { area: "session", key: "txnet.miniApp" },
  returnTo: { area: "session", key: "txnet.returnTo" },
} as const satisfies Record<string, StorageKey>;

function storageOf(area: Area): Storage | null {
  // Reading `window.localStorage` itself throws when site data is blocked.
  try {
    if (typeof window === "undefined") return null;
    return area === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

/** The stored string, or null when nothing is kept or storage cannot be read. */
export function readStored({ area, key }: StorageKey): string | null {
  try {
    return storageOf(area)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Store `value`, or remove the key for null; false when the browser refused. */
export function writeStored({ area, key }: StorageKey, value: string | null): boolean {
  const storage = storageOf(area);
  if (!storage) return false;
  try {
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/**
 * The stored JSON, parsed by `schema` (C-24: storage is outside input — a page
 * script or an older build may have written anything there). Null when
 * nothing is kept, the JSON is broken or the shape is not `schema`'s.
 */
export function readStoredJson<T>(at: StorageKey, schema: ZodType<T>): T | null {
  const raw = readStored(at);
  if (raw === null) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Store `value` as JSON; false when the browser refused. */
export function writeStoredJson(at: StorageKey, value: unknown): boolean {
  return writeStored(at, JSON.stringify(value));
}

/**
 * The same read as a JavaScript expression, for a pre-paint inline script
 * (`MOTION_SCRIPT`) that runs before any module can be imported.
 */
export function storageReadScript({ area, key }: StorageKey): string {
  return `(function () { try { return window.${area}Storage.getItem(${JSON.stringify(key)}); } catch (e) { return null; } })()`;
}
