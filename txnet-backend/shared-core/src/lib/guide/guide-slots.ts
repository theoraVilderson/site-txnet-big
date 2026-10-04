import type { GuideSurface, GuideTargetKind } from '@prisma/client';

/**
 * F-414-h — **the one registry of where a guide may be placed** (ADR-0116
 * point 2). A placement is `(surface, targetKind, targetRef)`; this says
 * which of those exist.
 *
 * A closed kind lists its refs: a panel section and a bot screen are named
 * here, never by URL or callback data, so a route move does not orphan a
 * guide. An open kind (a product, an app) is data another unit owns; the
 * registry holds its shape and the writer (F-414-c) checks it exists.
 *
 * Adding a slot is a line here, reviewed; a reseller cannot invent one. The
 * database holds what it can alone — the ref's shape and which surface a kind
 * shows on (`guide_placement_slot`, migration `20261004000500_guide_slots`).
 */

/** Panel sections a guide can be the help of. One per page in `site-pwa/src/lib/routes.ts`, by name. */
export const GUIDE_PANEL_SECTIONS = [
  'home',
  'services',
  'shop',
  'financial',
  'deposit',
  'tenant_billing',
  'settings',
  'accounts_add',
  'support',
  'support_inbox',
  'support_settings',
  'wheel',
  'lotteries',
  'gateways',
  'coupons',
  'ai',
  'catalog',
  'catalog_translations',
  'resellers',
  'my_resellers',
  'reseller_domains',
  'reseller_gateways',
  'reseller_bot',
  'reseller_catalog',
  'reseller_branding',
  'reseller_users',
  'manual_payments',
  'systems',
  'user_groups',
  'guides',
] as const;
export type GuidePanelSection = (typeof GUIDE_PANEL_SECTIONS)[number];

/** Bot screens a guide can be the help of — the main menu and what it opens. */
export const GUIDE_BOT_SCREENS = [
  'main_menu',
  'register',
  'login',
  'forgot_password',
  'accounts',
  'topup',
  'support',
  'wheel',
  'lotteries',
  'reseller',
  'time_zone',
  'miniapp',
] as const;
export type GuideBotScreen = (typeof GUIDE_BOT_SCREENS)[number];

/** Operating systems an install guide is written for. */
export const GUIDE_OSES = ['android', 'ios', 'windows', 'macos', 'linux'] as const;
export type GuideOs = (typeof GUIDE_OSES)[number];

/** Every ref's shape, the database's CHECK too: a slug or a lower-case UUID. */
export const GUIDE_SLOT_REF = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface GuideSlotKind {
  /** The surfaces a placement of this kind may name. */
  readonly surfaces: readonly GuideSurface[];
  /** The refs that exist, or `null` for an open kind held to {@link GUIDE_SLOT_REF} only. */
  readonly refs: readonly string[] | null;
}

const EVERYWHERE: readonly GuideSurface[] = ['panel', 'bot', 'any'];

export const GUIDE_SLOTS: Readonly<Record<GuideTargetKind, GuideSlotKind>> = {
  route: { surfaces: ['panel'], refs: GUIDE_PANEL_SECTIONS },
  bot_screen: { surfaces: ['bot'], refs: GUIDE_BOT_SCREENS },
  os: { surfaces: EVERYWHERE, refs: GUIDE_OSES },
  /** A catalog product id; that it is one the writer can see is F-414-c's check. */
  product: { surfaces: EVERYWHERE, refs: null },
  /** A client app's slug (`v2rayng`, `hiddify`); no unit owns the list yet. */
  app: { surfaces: EVERYWHERE, refs: null },
};

export type GuideSlotRefusal = 'bad_ref' | 'surface' | 'unknown_ref';

/** Why a placement names no registered slot, or `null` when it names one. */
export function guideSlotRefusal(placement: {
  surface: GuideSurface;
  targetKind: GuideTargetKind;
  targetRef: string;
}): GuideSlotRefusal | null {
  const kind = GUIDE_SLOTS[placement.targetKind];
  if (!GUIDE_SLOT_REF.test(placement.targetRef)) {
    return kind.refs ? 'unknown_ref' : 'bad_ref';
  }
  if (!kind.surfaces.includes(placement.surface)) return 'surface';
  if (kind.refs && !kind.refs.includes(placement.targetRef)) return 'unknown_ref';
  return null;
}
