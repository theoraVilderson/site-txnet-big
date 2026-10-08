import type { GUIDE_OSES, GUIDE_PANEL_SECTIONS } from "../guides/_lib/guides";
import {
  PANEL_ACCOUNTS_ADD,
  PANEL_AI,
  PANEL_CATALOG,
  PANEL_CATALOG_TRANSLATIONS,
  PANEL_COUPONS,
  PANEL_DEPOSIT,
  PANEL_FINANCIAL,
  PANEL_GATEWAYS,
  PANEL_GUIDES,
  PANEL_HOME,
  PANEL_LOTTERIES,
  PANEL_MANUAL_PAYMENTS,
  PANEL_MY_RESELLERS,
  PANEL_MY_SERVICES,
  PANEL_RESELLERS,
  PANEL_SETTINGS,
  PANEL_SHOP,
  PANEL_SUPPORT,
  PANEL_SUPPORT_INBOX,
  PANEL_SUPPORT_SETTINGS,
  PANEL_SYSTEMS,
  PANEL_TENANT_BILLING,
  PANEL_USER_GROUPS,
  PANEL_WHEEL,
  myResellerBotPath,
  myResellerBrandingPath,
  myResellerCatalogPath,
  myResellerConsolePath,
  myResellerDomainsPath,
  myResellerGatewaysPath,
  myResellerUsersPath,
} from "@/lib/routes";

export type GuidePanelSection = (typeof GUIDE_PANEL_SECTIONS)[number];
export type GuideOs = (typeof GUIDE_OSES)[number];

/** A path segment that is an id; the route helpers build it, so this never names a URL by hand (C-10). */
const ID = "__id__";

/**
 * The page each panel section is the help of (F-414-e, ADR-0116 point 2): the
 * registry names a section, never a URL, so a moved page moves here and its
 * guides follow. Exhaustive over shared-core's sections — `guide-help.test.ts`
 * reads that file — so a section no page asks for fails a test.
 */
export const GUIDE_SECTION_ROUTES: Readonly<Record<GuidePanelSection, string>> = {
  home: PANEL_HOME,
  services: PANEL_MY_SERVICES,
  shop: PANEL_SHOP,
  financial: PANEL_FINANCIAL,
  deposit: PANEL_DEPOSIT,
  tenant_billing: PANEL_TENANT_BILLING,
  settings: PANEL_SETTINGS,
  accounts_add: PANEL_ACCOUNTS_ADD,
  support: PANEL_SUPPORT,
  support_inbox: PANEL_SUPPORT_INBOX,
  support_settings: PANEL_SUPPORT_SETTINGS,
  wheel: PANEL_WHEEL,
  lotteries: PANEL_LOTTERIES,
  gateways: PANEL_GATEWAYS,
  coupons: PANEL_COUPONS,
  ai: PANEL_AI,
  catalog: PANEL_CATALOG,
  catalog_translations: PANEL_CATALOG_TRANSLATIONS,
  resellers: PANEL_RESELLERS,
  my_resellers: PANEL_MY_RESELLERS,
  reseller_domains: myResellerDomainsPath(ID),
  reseller_gateways: myResellerGatewaysPath(ID),
  reseller_bot: myResellerBotPath(ID),
  reseller_catalog: myResellerCatalogPath(ID),
  reseller_branding: myResellerBrandingPath(ID),
  reseller_users: myResellerUsersPath(ID),
  manual_payments: PANEL_MANUAL_PAYMENTS,
  systems: PANEL_SYSTEMS,
  user_groups: PANEL_USER_GROUPS,
  guides: PANEL_GUIDES,
};

// The console itself is `my_resellers`; listed so its id segment is matched like the others'.
const PATTERNS: { section: GuidePanelSection; segments: string[] }[] = [
  ...Object.entries(GUIDE_SECTION_ROUTES).map(([section, path]) => ({ section: section as GuidePanelSection, segments: split(path) })),
  { section: "my_resellers" as const, segments: split(myResellerConsolePath(ID)) },
  // The caller's own workspace has no id in its address (F-061-n): the same sections at `/reseller/…`.
  { section: "my_resellers" as const, segments: split(myResellerConsolePath(ID, true)) },
  { section: "reseller_domains" as const, segments: split(myResellerDomainsPath(ID, true)) },
  { section: "reseller_gateways" as const, segments: split(myResellerGatewaysPath(ID, true)) },
  { section: "reseller_bot" as const, segments: split(myResellerBotPath(ID, true)) },
  { section: "reseller_catalog" as const, segments: split(myResellerCatalogPath(ID, true)) },
  { section: "reseller_branding" as const, segments: split(myResellerBrandingPath(ID, true)) },
  { section: "reseller_users" as const, segments: split(myResellerUsersPath(ID, true)) },
].sort((a, b) => b.segments.length - a.segments.length);

function split(path: string): string[] {
  return path.split(/[?#]/)[0].split("/").filter(Boolean);
}

/**
 * The section whose guides a path shows: the longest route that is the path or
 * a whole-segment prefix of it, as the menu highlights (`contract.shell.md`
 * rule 3); `home` when none is.
 */
export function sectionOfPath(pathname: string): GuidePanelSection {
  const at = split(pathname);
  for (const { section, segments } of PATTERNS) {
    if (segments.length <= at.length && segments.every((s, i) => s === ID || s === at[i])) return section;
  }
  return "home";
}

/** The system an install guide opens on, from the browser's own words; `null` when it says none of them. */
export function osFromUserAgent(ua: string): GuideOs | null {
  if (/android/i.test(ua)) return "android";
  if (/iphone|ipad|ipod/i.test(ua)) return "ios";
  if (/windows/i.test(ua)) return "windows";
  if (/macintosh|mac os x/i.test(ua)) return "macos";
  if (/linux|x11/i.test(ua)) return "linux";
  return null;
}

/** The search's own ceiling (`guideSearchQuerySchema`). */
const SEARCH_MAX = 100;

/**
 * What a new support conversation is matched against (F-414-k): the subject
 * and the start of the message, one line, cut to the search's 100 characters —
 * the start of a message says what it is about. Empty below 3 characters,
 * where nothing is worth asking.
 */
export function supportGuideQuery(subject: string, body: string): string {
  const q = `${subject} ${body}`.replace(/\s+/g, " ").trim().slice(0, SEARCH_MAX).trimEnd();
  return q.length < 3 ? "" : q;
}
