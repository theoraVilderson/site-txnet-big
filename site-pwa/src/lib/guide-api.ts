// Guides (F-414-c, ADR-0117), served by tenant-service on `/api/guides/settings`
// on the page's own domain, behind `forward-auth` and `guide.manage`. The
// caller's tenant decides whose guides they are: the platform owner's admin
// edits the platform's, a reseller's admin its own and sees the platform's as
// inherited. Texts are drafts until published (`guide/contract.md`).
import { API_BASE } from "./api-origin";
import { createApiClient } from "./api-request";
import { authApi } from "./auth-api";

const call = createApiClient({
  baseUrl: `${API_BASE}/guides/settings`,
  service: "tenant-service",
  credential: () => authApi.getAccessToken(),
  onCredentialRefused: (stale) => authApi.refreshCredential(stale),
  credentialSettled: () => authApi.credentialSettled(),
});

/** Prisma's `GuideKind`. */
export type GuideKind = "product" | "os" | "app" | "section";
/** Prisma's `GuideSurface`. */
export type GuideSurface = "panel" | "bot" | "any";
/** Prisma's `GuideTargetKind`. */
export type GuideTargetKind = "route" | "bot_screen" | "product" | "os" | "app";
/** Prisma's `Language`. */
export type GuideLang = "fa" | "en";
/** Derived by tenant-service: `archived` when inactive, `published` once published, else `draft`. */
export type GuideState = "draft" | "published" | "archived";
export type CalloutTone = "info" | "tip" | "warning" | "danger";

/** shared-core `guideBlockSchema`. A file is an object key, never a URL. */
export type GuideBlock =
  | { type: "text"; text: string }
  | { type: "image"; file: string; alt: string; caption?: string }
  | { type: "video"; file: string; poster: string; caption?: string }
  | { type: "steps"; items: { text: string; image?: string }[] }
  | { type: "callout"; tone: CalloutTone; title?: string; text: string };

export interface GuideText {
  lang: GuideLang;
  title: string;
  blocks: GuideBlock[];
}

export interface GuidePlacement {
  surface: GuideSurface;
  targetKind: GuideTargetKind;
  targetRef: string;
}

export interface GuideSummary {
  id: string;
  key: string;
  kind: GuideKind;
  sortOrder: number;
  state: GuideState;
  hasDraft: boolean;
  publishedLangs: GuideLang[];
  placements: GuidePlacement[];
  publishedAt: string | null;
  updatedAt: string;
}

export interface GuideDetail extends GuideSummary {
  owner: "platform" | "own";
  /** A platform guide seen by a reseller: override or hide it, never edit it. */
  readOnly: boolean;
  published: GuideText[];
  draft: GuideText[];
}

export interface InheritedGuide {
  id: string;
  key: string;
  kind: GuideKind;
  title: string;
  placements: GuidePlacement[];
  overriddenBy: string | null;
  hidden: boolean;
}

export interface GuideList {
  owner: "platform" | "tenant";
  own: GuideSummary[];
  inherited: InheritedGuide[];
}

export interface GuidePreview {
  key: string;
  lang: GuideLang;
  title: string;
  blocks: GuideBlock[];
  source: "draft" | "published";
}

export interface CreateGuideBody {
  key: string;
  kind: GuideKind;
  sortOrder?: number;
  texts: GuideText[];
  placements?: GuidePlacement[];
}

/** tenant-service's `GuideStat` (F-414-l, ADR-0119). */
export interface GuideStat {
  guideId: string;
  views: number;
  panelViews: number;
  botViews: number;
  helpful: number;
  notHelpful: number;
}
export const GUIDE_STATS_DAYS = [7, 30, 90] as const;
export type GuideStatsDays = (typeof GUIDE_STATS_DAYS)[number];

const json = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });
const at = (id: string, rest = "") => `/${encodeURIComponent(id)}${rest}`;

export const guideApi = {
  list: () => call<GuideList>("", { method: "GET" }),
  get: (id: string) => call<GuideDetail>(at(id), { method: "GET" }),
  create: (body: CreateGuideBody) => call<GuideDetail>("", json("POST", body)),
  update: (id: string, body: { kind?: GuideKind; sortOrder?: number }) => call<GuideDetail>(at(id), json("PATCH", body)),
  remove: (id: string) => call<void>(at(id), { method: "DELETE" }),
  saveDraft: (id: string, texts: GuideText[]) => call<GuideDetail>(at(id, "/draft"), json("PUT", { texts })),
  discardDraft: (id: string) => call<GuideDetail>(at(id, "/draft"), { method: "DELETE" }),
  preview: (id: string, lang: GuideLang) => call<GuidePreview>(at(id, `/preview?lang=${lang}`), { method: "GET" }),
  publish: (id: string) => call<GuideDetail>(at(id, "/publish"), { method: "POST" }),
  archive: (id: string) => call<GuideDetail>(at(id, "/archive"), { method: "POST" }),
  restore: (id: string) => call<GuideDetail>(at(id, "/restore"), { method: "POST" }),
  setPlacements: (id: string, placements: GuidePlacement[]) => call<GuideDetail>(at(id, "/placements"), json("PUT", { placements })),
  /** PNG, WebP or JPEG, ≤ 2 MiB; the key goes into an image block. */
  upload(id: string, file: File): Promise<{ key: string }> {
    const form = new FormData();
    form.append("file", file);
    return call<{ key: string }>(at(id, "/files"), { method: "POST", body: form });
  },
  /** MP4 or WebM, ≤ 50 MiB (F-414-i); the key goes into a video block, beside an uploaded poster image. */
  uploadVideo(id: string, file: File): Promise<{ key: string }> {
    const form = new FormData();
    form.append("file", file);
    return call<{ key: string }>(at(id, "/videos"), { method: "POST", body: form });
  },
  /** Views in the last `days` and current votes, per guide id (F-414-l): a reseller its own users', the platform owner every reseller's. */
  stats: (days: GuideStatsDays) => call<{ days: number; since: string; stats: GuideStat[] }>(`/stats?days=${days}`, { method: "GET" }),
  override: (key: string) => call<GuideDetail>(`/inherited/${encodeURIComponent(key)}/override`, { method: "POST" }),
  hide: (key: string) => call<void>(`/inherited/${encodeURIComponent(key)}/hidden`, { method: "PUT" }),
  unhide: (key: string) => call<void>(`/inherited/${encodeURIComponent(key)}/hidden`, { method: "DELETE" }),
};

/**
 * Where a guide file is served on this Host (object-storage rule 2): the page's
 * own domain, which also serves the platform's `guides/` files (ADR-0117).
 */
export const guideFileUrl = (key: string) => `${API_BASE}/public/tenant/files/${key.split("/").map(encodeURIComponent).join("/")}`;

/**
 * Where a guide video is served (F-414-i, ADR-0118): the media server over the
 * object store, on this Host, never a Nest route — Range is the store's. The
 * one place that changes when the store becomes a bucket or a CDN.
 */
export const guideVideoUrl = (key: string) => `${API_BASE}/public/media/${key.split("/").map(encodeURIComponent).join("/")}`;

// ------------------------------------------------------------------ reading

/**
 * The guides a visitor reads (F-414-e) — tenant-service's public
 * `/api/public/tenant/guides` (F-414-b) on the page's own Host, with no
 * credential: a stranger's first screen may need its help, and the Host says
 * whose guides they are. The browser's cache revalidates by ETag, so a repeat
 * read is a 304 with no query behind it.
 */
const read = createApiClient({ baseUrl: `${API_BASE}/public/tenant/guides`, service: "tenant-service" });

/** tenant-service's `ResolvedGuide`: the text in the language served (`lang`). */
export interface ResolvedGuide {
  /** The row shown; what a view or a vote counts against (F-414-l). */
  id: string;
  key: string;
  kind: GuideKind;
  owner: "platform" | "own";
  lang: GuideLang;
  title: string;
  blocks: GuideBlock[];
  sortOrder: number;
  updatedAt: string;
}

export const guideReadApi = {
  /** The guides placed in one slot, for the panel, by their order. */
  forSlot: (targetKind: GuideTargetKind, targetRef: string) =>
    read<{ guides: ResolvedGuide[] }>(`?${new URLSearchParams({ placement: `${targetKind}:${targetRef}`, surface: "panel" })}`, { method: "GET" }).then(
      (r) => r.guides,
    ),
  /** One guide by key; a 404 when this tenant sees none. */
  one: (key: string) => read<{ guide: ResolvedGuide }>(`/${encodeURIComponent(key)}`, { method: "GET" }).then((r) => r.guide),
  /** A guide shown whole (F-414-l): the server counts one a day per viewer, and always answers 204. */
  view: (key: string) => read<void>(`/${encodeURIComponent(key)}/view`, { method: "POST" }),
  /** Every guide this tenant shows on the panel holding all of `q`'s words (F-414-j), at most a page. */
  search: (q: string) =>
    search<{ hits: GuideHit[] }>(`?${new URLSearchParams({ q, surface: "panel" })}`, { method: "GET" }).then((r) => r.hits),
  /** The guides a support message may be answered by (F-414-k): any meaningful word of it, ranked. */
  suggest: (q: string) =>
    search<{ hits: GuideHit[] }>(`?${new URLSearchParams({ q, surface: "panel", match: "any" })}`, { method: "GET" }).then((r) => r.hits),
};

/** `GET /api/public/tenant/guide-search` (F-414-j) — its own path, so no guide key shadows it. */
const search = createApiClient({ baseUrl: `${API_BASE}/public/tenant/guide-search`, service: "tenant-service" });

/** tenant-service's `GuideHit`: enough to list a result; the guide is read by key. */
export interface GuideHit {
  key: string;
  kind: GuideKind;
  lang: GuideLang;
  title: string;
  snippet: string;
}

// ----------------------------------------------------------------- feedback

/**
 * A signed-in user's helpful / not-helpful vote (F-414-l, ADR-0119) —
 * `/api/guides/feedback/:key`, behind `forward-auth`, no permission. One per
 * user per guide; voting again changes it.
 */
const feedback = createApiClient({
  baseUrl: `${API_BASE}/guides/feedback`,
  service: "tenant-service",
  credential: () => authApi.getAccessToken(),
  onCredentialRefused: (stale) => authApi.refreshCredential(stale),
  credentialSettled: () => authApi.credentialSettled(),
});

export const guideFeedbackApi = {
  mine: (key: string) => feedback<{ helpful: boolean | null }>(`/${encodeURIComponent(key)}`, { method: "GET" }),
  vote: (key: string, helpful: boolean) => feedback<{ helpful: boolean }>(`/${encodeURIComponent(key)}`, json("PUT", { helpful })),
};
