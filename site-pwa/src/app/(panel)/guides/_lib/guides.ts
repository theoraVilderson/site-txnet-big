import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { Me } from "@/lib/auth-api";
import type {
  CalloutTone,
  GuideBlock,
  GuideKind,
  GuideLang,
  GuidePlacement,
  GuideState,
  GuideSurface,
  GuideTargetKind,
  GuideText,
} from "@/lib/guide-api";
import { holdsPermission } from "@/lib/permissions";

/** The guide pages' strings as generated constants (C-06). */
export const GUIDE_KEYS = FrontendI18nKeys.common.guides;
const K = GUIDE_KEYS;

export const GUIDE_MANAGE = "guide.manage";
export const canManageGuides = (me: Me | null) => holdsPermission(me?.permissions, GUIDE_MANAGE);

/** Prisma's `Language`, in the order the editor shows them. */
export const GUIDE_LANGS: readonly GuideLang[] = ["fa", "en"];
export const GUIDE_KINDS: readonly GuideKind[] = ["os", "app", "product", "section"];
export const CALLOUT_TONES: readonly CalloutTone[] = ["info", "tip", "warning", "danger"];
/** Block types the editor offers — every one shared-core has (video since F-414-i). */
export const EDITABLE_BLOCKS = ["text", "image", "video", "steps", "callout"] as const;
export type EditableBlockType = (typeof EDITABLE_BLOCKS)[number];

/**
 * The slot registry, as shared-core's `guide-slots.ts` holds it (ADR-0116
 * point 2) — copied because the panel cannot import shared-core, and held
 * equal to it by `guides.test.ts`, which reads that file.
 */
export const GUIDE_PANEL_SECTIONS = [
  "home", "services", "shop", "financial", "deposit", "tenant_billing", "settings", "accounts_add", "support",
  "support_inbox", "support_settings", "wheel", "lotteries", "gateways", "coupons", "ai", "catalog",
  "catalog_translations", "resellers", "my_resellers", "reseller_domains", "reseller_gateways", "reseller_bot",
  "reseller_catalog", "reseller_branding", "reseller_users", "manual_payments", "systems", "user_groups", "guides",
] as const;
export const GUIDE_BOT_SCREENS = [
  "main_menu", "register", "login", "forgot_password", "accounts", "topup", "support", "wheel", "lotteries",
  "reseller", "time_zone", "miniapp",
] as const;
export const GUIDE_OSES = ["android", "ios", "windows", "macos", "linux"] as const;

const EVERYWHERE: readonly GuideSurface[] = ["any", "panel", "bot"];
export const GUIDE_SLOTS: Readonly<Record<GuideTargetKind, { surfaces: readonly GuideSurface[]; refs: readonly string[] | null }>> = {
  os: { surfaces: EVERYWHERE, refs: GUIDE_OSES },
  app: { surfaces: EVERYWHERE, refs: null },
  product: { surfaces: EVERYWHERE, refs: null },
  route: { surfaces: ["panel"], refs: GUIDE_PANEL_SECTIONS },
  bot_screen: { surfaces: ["bot"], refs: GUIDE_BOT_SCREENS },
};
export const GUIDE_TARGET_KINDS = Object.keys(GUIDE_SLOTS) as GuideTargetKind[];
const SLOT_REF = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const GUIDE_KEY_PATTERN = /^[a-z0-9_]{1,60}$/;

/** tenant-service's `GuideRejection` → its sentence. A reason missing here fails the test. */
export const REFUSAL_KEYS = {
  guide_unknown: K.refusal.guide_unknown,
  guide_not_inherited: K.refusal.guide_not_inherited,
  guide_key_taken: K.refusal.guide_key_taken,
  guide_no_draft: K.refusal.guide_no_draft,
  guide_invalid: K.refusal.guide_invalid,
  guide_slot: K.refusal.guide_slot,
  guide_product_unknown: K.refusal.guide_product_unknown,
  guide_file: K.refusal.guide_file,
  too_large: K.refusal.too_large,
  type_not_allowed: K.refusal.type_not_allowed,
  type_mismatch: K.refusal.type_not_allowed,
} as const;

export function refusalKey(e: unknown): string | null {
  const reason = (e as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" && reason in REFUSAL_KEYS ? REFUSAL_KEYS[reason as keyof typeof REFUSAL_KEYS] : null;
}

export const STATE_KEYS: Record<GuideState, string> = K.state;
export const KIND_KEYS: Record<GuideKind, string> = K.kind;

/** A fresh block of `type`, empty where the author has to write. */
export function emptyBlock(type: EditableBlockType): GuideBlock {
  switch (type) {
    case "text":
      return { type, text: "" };
    case "image":
      return { type, file: "", alt: "" };
    case "video":
      return { type, file: "", poster: "" };
    case "steps":
      return { type, items: [{ text: "" }] };
    case "callout":
      return { type, tone: "info", text: "" };
  }
}

/** `blocks` with the one at `i` moved by `by` (−1 up, +1 down); out of range is a no-op. */
export function moveBlock<T>(blocks: readonly T[], i: number, by: -1 | 1): T[] {
  const j = i + by;
  if (i < 0 || i >= blocks.length || j < 0 || j >= blocks.length) return [...blocks];
  const next = [...blocks];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

/** The editor's texts: every language, an untouched one empty. */
export function textsForm(texts: readonly GuideText[]): GuideText[] {
  return GUIDE_LANGS.map((lang) => texts.find((t) => t.lang === lang) ?? { lang, title: "", blocks: [] });
}

const blank = (t: GuideText) => t.title.trim() === "" && t.blocks.length === 0;

/** What `PUT …/draft` gets: the written languages, trimmed, optional fields dropped when empty. */
export function textsBody(form: readonly GuideText[]): GuideText[] {
  return form.filter((t) => !blank(t)).map((t) => ({ lang: t.lang, title: t.title.trim(), blocks: t.blocks.map(cleanBlock) }));
}

function cleanBlock(b: GuideBlock): GuideBlock {
  const opt = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text.trim() };
    case "image":
      return withoutUndefined({ type: "image", file: b.file, alt: b.alt.trim(), caption: opt(b.caption) });
    case "video":
      return withoutUndefined({ type: "video", file: b.file, poster: b.poster, caption: opt(b.caption) });
    case "steps":
      return { type: "steps", items: b.items.map((it) => withoutUndefined({ text: it.text.trim(), image: opt(it.image) })) };
    case "callout":
      return withoutUndefined({ type: "callout", tone: b.tone, title: opt(b.title), text: b.text.trim() });
  }
}

function withoutUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

const tooLong = (v: string | undefined, max: number) => (v ?? "").trim().length > max;
const empty = (v: string | undefined) => (v ?? "").trim() === "";

/**
 * Why tenant-service would refuse the texts, by `<lang>.<field>` — the bounds of
 * `guideBlocksSchema` and `guide_draft`'s CHECKs. Empty when they would pass.
 */
export function validateTexts(form: readonly GuideText[]): Record<string, string> {
  const errors: Record<string, string> = {};
  const texts = form.filter((t) => !blank(t));
  if (texts.length === 0) errors["texts"] = K.errors.noLanguage;
  for (const t of texts) {
    const at = (f: string) => `${t.lang}.${f}`;
    if (empty(t.title)) errors[at("title")] = K.errors.required;
    else if (tooLong(t.title, 120)) errors[at("title")] = K.errors.tooLong;
    if (t.blocks.length === 0) errors[at("blocks")] = K.errors.noBlocks;
    if (t.blocks.length > 100) errors[at("blocks")] = K.errors.tooManyBlocks;
    t.blocks.forEach((b, i) => {
      const e = blockError(b);
      if (e) errors[at(`blocks.${i}`)] = e;
    });
  }
  return errors;
}

function blockError(b: GuideBlock): string | null {
  switch (b.type) {
    case "text":
      return empty(b.text) ? K.errors.required : tooLong(b.text, 20_000) ? K.errors.tooLong : null;
    case "image":
      if (!b.file) return K.errors.noImage;
      return empty(b.alt) ? K.errors.altRequired : tooLong(b.alt, 200) || tooLong(b.caption, 300) ? K.errors.tooLong : null;
    case "video":
      if (!b.file) return K.errors.noVideo;
      if (!b.poster) return K.errors.noPoster;
      return tooLong(b.caption, 300) ? K.errors.tooLong : null;
    case "steps":
      if (b.items.length === 0 || b.items.length > 30) return K.errors.steps;
      return b.items.some((it) => empty(it.text)) ? K.errors.required : b.items.some((it) => tooLong(it.text, 2_000)) ? K.errors.tooLong : null;
    case "callout":
      return empty(b.text) ? K.errors.required : tooLong(b.text, 4_000) || tooLong(b.title, 120) ? K.errors.tooLong : null;
  }
}

/** Why a placement names no registered slot (shared-core `guideSlotRefusal`), or `null`. */
export function placementError(p: GuidePlacement): string | null {
  const slot = GUIDE_SLOTS[p.targetKind];
  if (!SLOT_REF.test(p.targetRef)) return K.errors.badRef;
  if (!slot.surfaces.includes(p.surface)) return K.errors.badSurface;
  if (slot.refs && !slot.refs.includes(p.targetRef)) return K.errors.badRef;
  return null;
}

/** A placement for `kind` that is already valid: its first surface and, for a closed kind, its first ref. */
export function emptyPlacement(kind: GuideTargetKind): GuidePlacement {
  const slot = GUIDE_SLOTS[kind];
  return { targetKind: kind, surface: slot.surfaces[0], targetRef: slot.refs?.[0] ?? "" };
}

/** The image keys a text names, for previews: a block's file, a step's image. */
export function imageKeys(blocks: readonly GuideBlock[]): string[] {
  return blocks.flatMap((b) => (b.type === "image" ? [b.file] : b.type === "steps" ? b.items.flatMap((i) => (i.image ? [i.image] : [])) : [])).filter(Boolean);
}
