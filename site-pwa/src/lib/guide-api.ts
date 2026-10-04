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
  override: (key: string) => call<GuideDetail>(`/inherited/${encodeURIComponent(key)}/override`, { method: "POST" }),
  hide: (key: string) => call<void>(`/inherited/${encodeURIComponent(key)}/hidden`, { method: "PUT" }),
  unhide: (key: string) => call<void>(`/inherited/${encodeURIComponent(key)}/hidden`, { method: "DELETE" }),
};

/**
 * Where a guide file is served on this Host (object-storage rule 2): the page's
 * own domain, which also serves the platform's `guides/` files (ADR-0117).
 */
export const guideFileUrl = (key: string) => `${API_BASE}/public/tenant/files/${key.split("/").map(encodeURIComponent).join("/")}`;
