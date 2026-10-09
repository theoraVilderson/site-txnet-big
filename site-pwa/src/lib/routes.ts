/**
 * Panel routes. Relative on purpose: this app *is* `panel.<domain>` and each
 * tenant is served on its own white-label domain, so an absolute URL would
 * pin every tenant to one host.
 */
export const PANEL_HOME = "/";
export const AUTH_LOGIN = "/auth/login";
export const AUTH_FORGOT_PASSWORD = "/auth/forgot-password";
/**
 * Where a reseller's own domain spends a handoff code from the platform panel
 * (F-061-f). The code rides in the fragment, which no request carries.
 */
export const AUTH_HANDOFF = "/auth/handoff";
/**
 * The account-creation screen. `register` is the name auth-api, the bot and
 * coinsite have always used; the panel called it `signup` until this constant
 * existed and the path was written out by hand at each call site.
 */
export const AUTH_REGISTER = "/auth/register";
/** Adding another account to the switch group (F-0205 / F-0209). */
export const PANEL_ACCOUNTS_ADD = "/accounts/add";
/** The user's own settings; first section: their email address (F-035-j). */
export const PANEL_SETTINGS = "/settings";
/** One settings tab, `?tab=` (UX-1-s, S1). */
export const panelSettingsTabPath = (tab: string) => `${PANEL_SETTINGS}?tab=${encodeURIComponent(tab)}`;
/**
 * The "my services" page (F-502-s) — the Grants a user holds, and the way back
 * to a subscription key that did not reach them. `/services` is the path
 * legacy used and the one the sidebar's `my-services` entry has always meant;
 * the later home of the `/sub` link (F-113).
 */
export const PANEL_MY_SERVICES = "/services";
/** My services on a name search, `?q=` (F-307-n) — the palette's service hits (UX-1-o). Never a config link: that is a credential. */
export const panelMyServicesSearchPath = (q: string) => `${PANEL_MY_SERVICES}?q=${encodeURIComponent(q)}`;
/**
 * The shop (F-111-e): what the caller may buy, buy -> invoice -> pay from the
 * wallet. The sidebar's `buy` entry.
 */
export const PANEL_SHOP = "/shop";
/** The shop opened on one invoice — where a top-up for its shortfall comes back to. */
export const panelShopInvoicePath = (invoiceId: string) => `${PANEL_SHOP}?invoice=${encodeURIComponent(invoiceId)}`;
/** The shop opened on one plan's checkout — where a suggestion's call to action goes (F-038-h). */
export const panelShopVariantPath = (variantId: string) => `${PANEL_SHOP}?variant=${encodeURIComponent(variantId)}`;
/**
 * The financial history page (F-093-d) — the wallet ledger and the top-up
 * attempts, as two lists. The sidebar's `financial-history` entry and the
 * wallet control's `history` quick action both point here.
 */
export const PANEL_FINANCIAL = "/financial";
/**
 * The top-up page (F-093-e). Under `/financial` on purpose: `activeHref` then
 * lights the financial group for it without a second rule
 * (`panel-web/contract.shell.md` rule 3).
 */
export const PANEL_DEPOSIT = "/financial/deposit";
/**
 * The top-up page opened for an invoice's shortfall (F-111-e): `missing` is
 * pre-filled (raised to the gateway's minimum there) and the page links back to
 * the invoice. No coupon code ever rides in it.
 */
export const panelDepositForInvoicePath = (invoiceId: string, missing: string, currency: string) =>
  `${PANEL_DEPOSIT}?${new URLSearchParams({ invoice: invoiceId, missing, currency })}`;
/** A reseller's billing wallet with the platform (F-019-d). */
export const PANEL_TENANT_BILLING = "/financial/billing";
/**
 * A reseller tops up that wallet (F-019-e). Under the billing page, so
 * `activeHref` lights its menu entry without a rule of its own.
 */
export const PANEL_TENANT_BILLING_TOPUP = "/financial/billing/topup";
/**
 * Payment gateway management (F-102-d). One route for every audience: the
 * platform owner sees every gateway and the links, a tenant its own (D-31).
 * No role word in it (F-098).
 */
export const PANEL_GATEWAYS = "/gateways";
/**
 * Coupon and gift-code management (F-502-g/h). One route for every audience:
 * billing answers the platform owner every coupon, a tenant its own (D-33).
 */
export const PANEL_COUPONS = "/coupons";
/**
 * The tenant's AI page (F-038-j2): settings, discount offers, at-risk
 * customers, the uplift report. ai answers each tenant its own (`ai.manage`).
 */
export const PANEL_AI = "/ai";
/**
 * Catalog management (F-026-f). One route for every audience: billing answers
 * the platform owner every item, a tenant its own (D-34).
 */
export const PANEL_CATALOG = "/catalog";
/**
 * Catalog translation review (F-1533-e, ADR-0050): machine drafts of item
 * names beside their fa/en source, published by a person. Same audience rule.
 */
export const PANEL_CATALOG_TRANSLATIONS = "/catalog/translations";
/**
 * The platform owner's reseller administration (F-018-k): list, create, package
 * and period, status, billing adjustment. No role word in it (F-098); the menu
 * and tenant-service both admit the platform owner alone.
 */
export const PANEL_RESELLERS = "/resellers";
/**
 * One reseller's page (F-019-k): its facts, package and status, its billing
 * ledger and the balance adjustment. The list opens this; nothing else
 * spells the path (C-10).
 */
export const panelResellerPath = (id: string) => `${PANEL_RESELLERS}/${encodeURIComponent(id)}`;
/**
 * The packages the platform sells resellers (F-118-n5): prices, features and
 * the wholesale rate per GiB. Under `PANEL_RESELLERS`, so that entry stays lit;
 * the static segment wins over `[id]`, as `/buy` does.
 */
export const PANEL_RESELLER_PACKAGES = `${PANEL_RESELLERS}/packages`;
/**
 * What a reseller may spend of the platform's (F-019-r, ADR-0106): each limit
 * for every reseller, per package, and for one or several resellers. Under
 * `PANEL_RESELLERS`; the static segment wins over `[id]`, as `/packages` does.
 */
export const PANEL_RESELLER_LIMITS = `${PANEL_RESELLERS}/limits`;
/**
 * Where a platform user buys a reseller of their own (F-019-i). A sibling of
 * the owner's administration on purpose: `activeHref` takes the longest match,
 * so this lights its own menu entry and not `PANEL_RESELLERS`, and the static
 * segment wins over `[id]`, which is always a uuid.
 */
export const PANEL_RESELLER_PURCHASE = `${PANEL_RESELLERS}/buy`;
/**
 * A reseller's own workspace on the platform panel (ADR-0064 (4)): its owner,
 * its staff and platform support configure it here by the path's id, never by
 * the session's tenant. Not under `PANEL_RESELLERS`, which is the platform
 * owner's administration.
 */
export const PANEL_MY_RESELLERS = "/my-resellers";
/**
 * The same workspace on the reseller's **own** panel domain (F-061-n), where
 * the session's tenant is the reseller. It carries no id: the visitor is on
 * that reseller's domain already, and a `/my-resellers/<id>` there would show
 * a customer-facing address the platform's own way of managing it.
 */
export const PANEL_RESELLER_SELF = "/reseller";
/**
 * Where one reseller's workspace is rooted: by id on the platform panel, id-less
 * on its own domain (`self`, read by `useWorkspaceSelf`). Every workspace path
 * below takes the same `self`, so one screen links right on either host.
 */
export const resellerWorkspaceRoot = (id: string, self = false) =>
  self ? PANEL_RESELLER_SELF : `${PANEL_MY_RESELLERS}/${encodeURIComponent(id)}`;
/**
 * A reseller's onboarding console (F-066-w): the checklist, and what stays
 * closed until a domain is proved. The workspace's home — the switcher's
 * "my reseller" opens it (UX-2-a).
 */
export const myResellerConsolePath = (id: string, self = false) => resellerWorkspaceRoot(id, self);
/**
 * A reseller's settings (UX-2-b): operating currency, time zone, limits and
 * quotas, package change and support access — the cards the home once stacked.
 */
export const myResellerSettingsPath = (id: string, self = false) => `${resellerWorkspaceRoot(id, self)}/settings`;
/**
 * A reseller's setup wizard (UX-2-c, F-213): the onboarding route's steps one at
 * a time, opened at the first one not done — nothing about where it was left is stored.
 */
export const myResellerSetupPath = (id: string, self = false) => `${resellerWorkspaceRoot(id, self)}/setup`;
/** A reseller's custom domains: add one, the records to publish, "check now" (F-066-w2). */
export const myResellerDomainsPath = (id: string, self = false) => `${resellerWorkspaceRoot(id, self)}/domains`;
/**
 * A reseller's payment gateways (F-066-w4): the `/gateways` page's components
 * over the route that names the reseller, so the owner configures its gateways
 * and never the session tenant's.
 */
export const myResellerGatewaysPath = (id: string, self = false) => `${resellerWorkspaceRoot(id, self)}/gateways`;
/**
 * A reseller's bot (F-066-w6): connect a Telegram or Bale bot from a pasted
 * token, and retire one. Singular — a reseller has one bot per messenger
 * (`primary`, C-05), so the screen is `/bot`, not `/bots`.
 */
export const myResellerBotPath = (id: string, self = false) => `${resellerWorkspaceRoot(id, self)}/bot`;
/**
 * A reseller's catalog (F-066-w8): the `/catalog` page's components over the
 * route that names the reseller, so its owner prices its own products and
 * never the session tenant's — the platform's, for the visitor this is for.
 */
export const myResellerCatalogPath = (id: string, self = false) => `${resellerWorkspaceRoot(id, self)}/catalog`;
/** A reseller's brand settings: today the default name of a config line in a buyer's app (F-307-k). */
export const myResellerBrandingPath = (id: string, self = false) => `${resellerWorkspaceRoot(id, self)}/branding`;
/**
 * A reseller's users (F-311-v, over F-311-a): find one, and open their
 * services. By the path's reseller, never the session's tenant.
 */
export const myResellerUsersPath = (id: string, self = false) => `${resellerWorkspaceRoot(id, self)}/users`;
/** One user's services, as that reseller's admin reads and acts on them (F-311-v, over F-311-f/g). */
export const myResellerUserPath = (id: string, userId: string, self = false) =>
  `${myResellerUsersPath(id, self)}/${encodeURIComponent(userId)}`;
/**
 * A tenant's roles (F-1201-d, over F-1201-a): its own, with how many hold each,
 * and the templates. By the path's tenant — a reseller's for its owner, the
 * platform's for its staff — never the session's.
 */
export const myResellerRolesPath = (id: string, self = false) => `${resellerWorkspaceRoot(id, self)}/roles`;
/** Where that catalog's machine-drafted names are reviewed (F-1533-e on the reseller's surface). */
export const myResellerCatalogTranslationsPath = (id: string, self = false) => `${myResellerCatalogPath(id, self)}/translations`;
/**
 * The same address on the reseller's own domain: `/my-resellers/<id>/x` ->
 * `/reseller/x`, or `null` when `pathname` is not that reseller's workspace.
 */
export function selfWorkspacePath(pathname: string, id: string): string | null {
  const root = resellerWorkspaceRoot(id);
  if (pathname !== root && !pathname.startsWith(`${root}/`)) return null;
  return `${PANEL_RESELLER_SELF}${pathname.slice(root.length)}`;
}
/** Payments the gateway has not confirmed, for a person to settle (F-093-n). */
export const PANEL_MANUAL_PAYMENTS = "/payments/manual";
/** The platform owner's panels: registration, health, drift and the holds queue (F-027-ad). */
export const PANEL_SYSTEMS = "/systems";
/**
 * An admin's user groups and their members (F-114-m). One route for every
 * audience: auth-service answers each tenant its own groups (F-114-j).
 */
export const PANEL_USER_GROUPS = "/user-groups";
/** The user's lucky wheel: public odds, a spin the server decides, their own history (F-707-g). */
export const PANEL_WHEEL = "/wheel";
/** A tenant admin's wheel: prizes, odds, the cap, eligibility, versions and the day report (F-707-f). */
export const PANEL_WHEEL_SETTINGS = "/wheel/settings";
/** The user's lotteries: entry, ticket, results (F-707-n). */
export const PANEL_LOTTERIES = "/lotteries";
/** One drawn lottery's result and its in-browser check (F-707-n). */
export const panelLotteryPath = (id: string) => `${PANEL_LOTTERIES}/${encodeURIComponent(id)}`;
/** A tenant admin's lotteries: create, publish, cancel, the preview and the winners (F-707-o). */
export const PANEL_LOTTERIES_MANAGE = "/lotteries/manage";
export const panelLotteryManagePath = (id: string) => `${PANEL_LOTTERIES_MANAGE}/${encodeURIComponent(id)}`;
/** The user's support: their conversations, a new one, and one thread live (F-033-o). */
export const PANEL_SUPPORT = "/support";
/** The support page with the new-ticket form already open (UX-1-n, the palette's "new ticket"). */
export const PANEL_SUPPORT_NEW = `${PANEL_SUPPORT}?new=1`;
export const panelSupportThreadPath = (id: string) => `${PANEL_SUPPORT}/${encodeURIComponent(id)}`;
/** The agent's inbox and one thread from it (F-033-p); `support.agent`. */
export const PANEL_SUPPORT_INBOX = `${PANEL_SUPPORT}/inbox`;
export const panelSupportInboxThreadPath = (id: string) => `${PANEL_SUPPORT_INBOX}/${encodeURIComponent(id)}`;
/** A tenant admin's support settings: working hours, SLA targets, categories (F-033-p); `support.manage`. */
export const PANEL_SUPPORT_SETTINGS = `${PANEL_SUPPORT}/settings`;
/** A tenant admin's guides: own, inherited, drafts and publish (F-414-d); `guide.manage`. */
export const PANEL_GUIDES = "/guides";
export const panelGuidePath = (id: string) => `${PANEL_GUIDES}/${encodeURIComponent(id)}`;
/**
 * Where a bank returns a payer (F-093-f). These two are `billing`'s to name:
 * `deposit-callback.controller.ts` redirects to them by path, so they are the
 * one pair of routes here that cannot be renamed from this side alone.
 */
export const PAYMENT_SUCCESS = "/payment/success";
export const PAYMENT_FAILED = "/payment/failed";
/** A verifying payment (F-093-l): billing's callback writes this path out too. */
export const PAYMENT_PENDING = "/payment/pending";
