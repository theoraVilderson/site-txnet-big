import { Injectable, Logger } from '@nestjs/common';
import {
  ConfigProtocol,
  FulfilmentKind,
  PanelGroupStrategy,
  Prisma,
  QualityTier,
  RateCardAfterIncluded,
  RateCardMode,
  SeasonKind,
  VariantBillingMode,
  VariantVisibility,
} from '@prisma/client';

import { CATEGORY_MAX_DEPTH, DOOR_METERS, METER_KEYS, operatingCurrencyOf, PLATFORM_DEFAULT_TIMEZONE, platformTenantIdOf, refusedAudienceGroup, seasonOccurrences, servedByBytes, tenantTransaction, isPlatformTenant } from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { placeableMember } from '../traffic/group-fulfilment';
import { sellingInbounds } from '../traffic/selling-settings';
import { CatalogTextKind, CatalogTextService, ReviewItem, Texts, catalogTextKey, parseCatalogTextKey } from './catalog-texts';
import { campaignPlan, cancelVerdict, priceWriteVerdict, type CampaignRow } from './price-campaign';
import { SEASON_HORIZON_DAYS, seasonCampaignKey, seasonDateRefusal, seasonRuleOf, upcomingSeasonCampaigns } from './season-plan';
import { mustStateTraffic, trafficQuotaOf } from './traffic-quota';

/**
 * Catalog management (F-026-d; D-34, ADR-0049): categories, products, variants
 * and their price history, behind `catalog.manage`.
 *
 * **Who may touch what**, as in coupon management (ADR-0048 decision 8): the
 * platform owner manages platform items and every tenant's; any other tenant
 * only its own, and another tenant's item — or the platform's — is *not found*.
 *
 * **The pool follows the caller (ADR-0053, D-37).** A platform item is written
 * with `tenantId` null, which the catalog's `WITH CHECK` refuses to every
 * tenant's connection, so the platform owner is served on the cross-tenant
 * pool. Any other tenant runs in a `tenantTransaction` on the app pool, where
 * RLS (`NULL OR mine` to read, `mine` to write) stands behind the checks here.
 * {@link access} decides and {@link within} hands out the pool; a tenant admin
 * never needs another tenant's row, so there is no exception here.
 *
 * **Nothing is deleted.** A variant may already back a Grant or a coupon scope,
 * so an item is switched off (`isActive`) and a price is too. **A price is
 * history** (F-0602): a change is a new row, and a row effective in the past is
 * refused, because it would reprice an invoice already issued. The database
 * holds both for every writer (`catalog-schema.int.spec.ts`).
 *
 * **Names are text, not keys** (F-1533-d/f, ADR-0050 and amendments): a
 * category or product has a source language (default `DEFAULT_LANGUAGE`) and
 * is written with its name in that language, plus any others the admin types;
 * the server derives the i18n key (`catalog-texts.ts`). The written texts are
 * published inside the transaction, so a locale-service that does not answer
 * rolls the row back. Every other language is drafted from the source after it
 * commits — only when the write asks (`translateAll`, F-1533-i), and never
 * failing it; without it the others are left as they are and a reader falls
 * back to the source.
 *
 * **Categories nest, and a product sits in several** (F-026-q/r): a category
 * has an optional parent — the platform's or its own tenant's, never inside
 * itself, at most `CATEGORY_MAX_DEPTH` levels — and a product is filed in one
 * or more categories through `product_category_link`, first shown first.
 *
 * **A product unlocks only capabilities its tenant can see** (F-114-f-a,
 * ADR-0086): `featureKeys` names `product_capability` rows, the platform's or
 * its own tenant's (`capability_unknown`). A capability's key never changes,
 * and it is deleted only while no product and no Grant holds it
 * (`capability_in_use`). The check and the delete lock the capability rows, so
 * neither can slip past the other.
 *
 * **A rate card is history too** (F-118-m, ADR-0105 decisions 3 and 10): a
 * seller prices a platform meter on its own variant — mode, unit price, in its
 * operating currency — as a new row, and switches one off; the platform's
 * cards are the platform owner's, so a reseller finds them *not found* as it
 * finds the platform's variant. A card nothing would sell is refused rather
 * than stored (`rate_card_not_served`): what is served is a `vpn.traffic` card
 * on a metered variant in the shape the byte engine serves, and a card on a
 * `DOOR_METERS` meter on any variant (F-118-h). Stored, anything else would be
 * the newest card and make the variant unsellable (`grantMetersFromVariant`).
 */

/** `permissions`: the caller's keys where it acts, deciding the groups it may aim at (ADR-0143); a job acts with none. */
export type CatalogActor = { adminId: string; tenantId: string; ip: string; permissions: readonly string[] };

/** Why a catalog write or read was refused. Closed — the controller gives each a status. */
export type CatalogAdminRejection =
  | 'not_platform_owner'
  | 'tenant_not_found'
  | 'category_not_found'
  | 'product_not_found'
  | 'variant_not_found'
  | 'panel_group_not_found'
  | 'price_not_found'
  | 'key_taken'
  | 'sku_taken'
  | 'price_in_the_past'
  | 'text_key_invalid'
  | 'texts_unavailable'
  | 'lang_unknown'
  | 'source_text_missing'
  | 'category_cycle'
  | 'category_too_deep'
  | 'capability_not_found'
  | 'capability_unknown'
  | 'capability_in_use'
  /** PT-1-b: a group named for a product's audience is not the product's tenant's. */
  | 'group_not_found'
  | 'audience_not_allowed'
  /** A prepaid network variant with no `traffic_bytes` quota (F-111-p): 0 is unlimited, absent is refused. */
  | 'traffic_quota_required'
  /** F-118-m: a card names a meter the registry does not have. */
  | 'meter_not_found'
  | 'rate_card_not_found'
  /** F-118-m: a card no sale would take — see the class comment. */
  | 'rate_card_not_served'
  /** F-503-a: no such campaign of the caller's. */
  | 'campaign_not_found'
  /** F-503-a: its window meets one not cancelled — they would restore each other's prices. */
  | 'campaign_overlaps'
  /** F-503-a: cancelled only before it starts. */
  | 'campaign_started'
  /** F-503-a: a plain price from before a campaign's end — its restore row would undo it. */
  | 'campaign_pending'
  /** F-503-a: no price in effect at the start, in the variant's currency, to restore at the end. */
  | 'no_price_to_restore'
  /** F-503-a: a plain price already scheduled inside the window — the restore row would undo it. */
  | 'price_scheduled_in_campaign'
  /** F-503-a: one of a campaign's two rows — cancel the campaign instead. */
  | 'price_in_campaign'
  /** F-505-a: no such season of the caller's. */
  | 'season_not_found'
  /** F-505-a: a Jalali day the month never has (31 Mehr). */
  | 'season_date_invalid';

/** One group a variant may name (F-026-p). */
export type PanelGroupOption = {
  id: string;
  tenantId: string | null;
  name: string;
  strategy: PanelGroupStrategy;
  /** What its members' picked inbounds sell (network `contract.inbounds.md`), sorted; empty = nothing to place on. */
  protocols: ConfigProtocol[];
  healthyMembers: number;
};

export class CatalogAdminRefused extends Error {
  constructor(
    readonly reason: CatalogAdminRejection,
    detail = '',
  ) {
    super(`catalog refused: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'CatalogAdminRefused';
  }
}

/** `parentId`: the category it sits under; absent or `null` = top level (F-026-r). */
/** `translateAll` (F-1533-i): draft every language not written into the review list. Off when absent. */
type TranslateAll = { translateAll?: boolean };
export type CreateCategoryInput = TranslateAll & { tenantId?: string; parentId?: string | null; key: string; sourceLang?: string; name: Texts };
/** A new `sourceLang` needs `name` with that language's text. */
/** `archived: false` brings an archived category back, still switched off (F-026-l). `parentId: null` moves it to the top. */
export type UpdateCategoryInput = TranslateAll & { parentId?: string | null; sourceLang?: string; name?: Texts; isActive?: boolean; archived?: false };
export type CreateProductInput = TranslateAll & {
  tenantId?: string;
  /** One or more, distinct; the first is shown first (F-026-r). */
  categoryIds: string[];
  key: string;
  /** Absent: `DEFAULT_LANGUAGE`. */
  sourceLang?: string;
  name: Texts;
  /** `null` or absent: no description. */
  description?: Texts | null;
  fulfilmentKind: FulfilmentKind;
  featureKeys?: string[];
  defaultQuotas?: Record<string, unknown>;
};
export type UpdateProductInput = TranslateAll & {
  /** Replaces every category the product sits in, in this order. */
  categoryIds?: string[];
  sourceLang?: string;
  name?: Texts;
  /** `null` removes the description. */
  description?: Texts | null;
  featureKeys?: string[];
  defaultQuotas?: Record<string, unknown>;
  isActive?: boolean;
  /** `false` brings an archived product back into the list (F-026-h); it stays switched off. Archiving is `removeProducts`. */
  archived?: false;
};
/** A capability (F-114-f-a): the key is written once; the name is text, as a product's. */
export type CreateCapabilityInput = TranslateAll & { tenantId?: string; key: string; sourceLang?: string; name: Texts; description?: Texts | null };
export type UpdateCapabilityInput = TranslateAll & { sourceLang?: string; name?: Texts; description?: Texts | null };
export type VariantFields = {
  nameKey?: string | null;
  quotas?: Record<string, unknown>;
  durationDays?: number | null;
  visibility?: VariantVisibility;
  panelGroupId?: string | null;
  qualityTier?: QualityTier;
};
/** A rate card's terms (F-118-m). Quantities are strings in the meter's unit: bytes pass 2^53. */
export type RateCardTerms = {
  meterKey: string;
  unitSize: string;
  /** Per `unitSize`, in the variant's tenant's operating currency (C-02). */
  unitPrice: string;
  mode: RateCardMode;
  /** Absent: nothing included. */
  includedQuantity?: string;
  afterIncluded: RateCardAfterIncluded;
};
export type SetRateCardInput = RateCardTerms & { effectiveFrom?: string };
export type CreateVariantInput = VariantFields & {
  sku: string;
  billingMode: VariantBillingMode;
  visibility: VariantVisibility;
  /** The first price, base currency (C-02). */
  price: string;
  effectiveFrom?: string;
  /** A metered variant's first card, from the same instant as its first price (F-118-m). */
  rateCard?: RateCardTerms;
};
export type UpdateVariantInput = VariantFields & { isActive?: boolean };
export type SetPriceInput = { amount: string; effectiveFrom?: string };
/** `archived`: the archived products alone; the list otherwise leaves them out (F-026-h). */
export type ListProductsFilter = { categoryId?: string; tenantId?: string; archived?: boolean };
/** What `removeProducts` did to one id: gone for good, kept but archived, or not the caller's to remove. */
export type RemovalOutcome = { id: string; outcome: 'deleted' | 'archived' | 'not_found' };
/**
 * What `removeCategories` did to one id: gone, kept because a product or a category sits in it, or not the
 * caller's to remove. Asked to take its products with it (F-026-l): `archived` when a sold product stays in it,
 * and `products` counts what happened to its own products — one filed elsewhere too is only taken out of it.
 */
export type CategoryRemovalOutcome = {
  id: string;
  outcome: 'deleted' | 'archived' | 'has_products' | 'has_children' | 'not_found';
  products?: { deleted: number; archived: number; unlinked: number };
};
/** `archived`: the archived categories alone; the list otherwise leaves them out (F-026-l). */
export type ListCategoriesFilter = { archived?: boolean };
export type PublishTextsInput = { lang: string; keys: string[] };
export type EditTextsInput = { lang: string; texts: Record<string, string> };

export type PriceView = { id: string; variantId: string; amount: string; currencyCode: string; effectiveFrom: Date; isActive: boolean };

/** F-503-a: a time-boxed price — instants as ISO strings from the client, the server's clock decides. */
export type CreateCampaignInput = { amount: string; startsAt: string; endsAt: string };
/** A campaign and its two rows: `priceId` from its start, `restorePriceId` from its end. */
export type CampaignView = {
  id: string;
  tenantId: string;
  variantId: string;
  amount: string;
  currencyCode: string;
  startsAt: Date;
  endsAt: Date;
  cancelledAt: Date | null;
  priceId: string | null;
  restorePriceId: string | null;
  restoreAmount: string | null;
};

/** F-505-a: a season — its own fields, its prices, and its next occurrence on its tenant's clock. */
export type SeasonInput = {
  name: string;
  kind: SeasonKind;
  month?: number;
  day?: number;
  weekday?: number;
  startMinute: number;
  durationMinutes: number;
  /** Whose: absent = the caller's; another tenant's for the platform owner alone (`ownerOfNew`). */
  tenantId?: string;
};
export type SeasonPatch = Partial<Pick<SeasonInput, 'name' | 'month' | 'day' | 'weekday' | 'startMinute' | 'durationMinutes'>> & { isActive?: boolean };
export type SeasonView = {
  id: string;
  tenantId: string;
  name: string;
  kind: SeasonKind;
  month: number | null;
  day: number | null;
  weekday: number | null;
  startMinute: number;
  durationMinutes: number;
  isActive: boolean;
  prices: Array<{ variantId: string; amount: string }>;
  next: { startsAt: Date; endsAt: Date } | null;
};

type SeasonRowWithPrices = Prisma.SeasonGetPayload<{ include: { prices: true } }>;

function seasonView(s: SeasonRowWithPrices, zone: string, now: Date): SeasonView {
  const [next] = s.isActive ? seasonOccurrences(seasonRuleOf(s), zone, now, new Date(now.getTime() + 400 * 86_400_000)) : [];
  return {
    id: s.id,
    tenantId: s.tenantId,
    name: s.name,
    kind: s.kind,
    month: s.month,
    day: s.day,
    weekday: s.weekday,
    startMinute: s.startMinute,
    durationMinutes: s.durationMinutes,
    isActive: s.isActive,
    prices: s.prices.map((p) => ({ variantId: p.variantId, amount: p.amount.toFixed(2) })).sort((a, b) => a.variantId.localeCompare(b.variantId)),
    next: next ?? null,
  };
}

function campaignView(
  c: { id: string; tenantId: string; variantId: string; amount: Prisma.Decimal; currencyCode: string; startsAt: Date; endsAt: Date; cancelledAt: Date | null },
  prices: ReadonlyArray<{ id: string; amount: Prisma.Decimal; campaignEndsAt: Date | null }>,
): CampaignView {
  const own = prices.find((p) => p.campaignEndsAt !== null);
  const restore = prices.find((p) => p.campaignEndsAt === null);
  return {
    id: c.id,
    tenantId: c.tenantId,
    variantId: c.variantId,
    amount: c.amount.toFixed(2),
    currencyCode: c.currencyCode,
    startsAt: c.startsAt,
    endsAt: c.endsAt,
    cancelledAt: c.cancelledAt,
    priceId: own?.id ?? null,
    restorePriceId: restore?.id ?? null,
    restoreAmount: restore ? restore.amount.toFixed(2) : null,
  };
}
/** A rate card as the routes answer it (F-118-m); quantities as strings — JSON has no BigInt. */
export type RateCardView = {
  id: string;
  variantId: string;
  meterKey: string;
  unitSize: string;
  unitPrice: string;
  currencyCode: string;
  mode: RateCardMode;
  includedQuantity: string;
  afterIncluded: RateCardAfterIncluded;
  effectiveFrom: Date;
  isActive: boolean;
};
export type CategoryView = {
  id: string;
  tenantId: string;
  /** The platform's row (ADR-0142): seen by every tenant, managed by the platform owner alone. */
  platform: boolean;
  /** The category it sits under, or `null` at the top (F-026-q). */
  parentId: string | null;
  key: string;
  nameKey: string;
  /** The language the admin wrote it in; a reader's fallback. `DEFAULT_LANGUAGE` for a row from before F-1533-f. */
  sourceLang: string;
  isActive: boolean;
  /** Set when a removal with its products found a sold one in it and kept it (F-026-l). */
  archivedAt: Date | null;
};
export type CapabilityView = {
  id: string;
  tenantId: string;
  /** The platform's row (ADR-0142): seen by every tenant, managed by the platform owner alone. */
  platform: boolean;
  key: string;
  nameKey: string;
  descriptionKey: string | null;
  /** A row the migration wrote from a key in use has no text yet: a reader falls back to the key. */
  sourceLang: string;
};
export type ProductView = {
  id: string;
  tenantId: string;
  /** The platform's row (ADR-0142): seen by every tenant, managed by the platform owner alone. */
  platform: boolean;
  /** Every category it sits in, first shown first (F-026-q). */
  categoryIds: string[];
  key: string;
  nameKey: string;
  descriptionKey: string | null;
  sourceLang: string;
  fulfilmentKind: FulfilmentKind;
  featureKeys: string[];
  defaultQuotas: unknown;
  isActive: boolean;
  /** Set when a removal found the product referenced and kept it (F-026-h). */
  archivedAt: Date | null;
};
/** A product as a list or an editor reads it: with the groups it is sold to — none = every user (PT-1-b). */
export type AudiencedProductView = ProductView & { userGroupIds: string[] };
export type VariantView = {
  id: string;
  tenantId: string;
  /** The platform's row (ADR-0142): seen by every tenant, managed by the platform owner alone. */
  platform: boolean;
  productId: string;
  sku: string;
  nameKey: string | null;
  quotas: unknown;
  durationDays: number | null;
  billingMode: VariantBillingMode;
  visibility: VariantVisibility;
  panelGroupId: string | null;
  qualityTier: QualityTier;
  isActive: boolean;
  /** Newest `effectiveFrom` first. */
  prices: PriceView[];
  /** Every meter's card history, newest `effectiveFrom` first (F-118-m). */
  rateCards: RateCardView[];
};

type Row = Record<string, unknown>;

/** Clock skew tolerated between the admin's "now" and ours before a price counts as backdated. */
const PAST_SKEW_MS = 60_000;

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
/** The database's own cycle refusal (`category_parent_ok`): two re-parents that each passed the check here. */
const isCategoryCycle = (e: unknown) => e instanceof Error && /category_cycle/.test(e.message);
/**
 * A delete some foreign key still points at: a Grant, a coupon, a coupon scope —
 * or whatever references a variant next. `ON DELETE RESTRICT` is Postgres
 * `23001`, which Prisma does not map and throws as an unknown error; a
 * `NO ACTION` key is `23503`, mapped to `P2003`.
 */
const isStillReferenced = (e: unknown) =>
  (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003') ||
  (e instanceof Prisma.PrismaClientUnknownRequestError && /code: "(23001|23503)"/.test(e.message));

/** The database's own refusal (`capability_key_free`): a tenant key the platform holds, or the reverse. */
const isCapabilityKeyTaken = (e: unknown) => e instanceof Error && /capability_key_taken/.test(e.message);

/** A row's source language, `DEFAULT_LANGUAGE` when it has none (a row from before F-1533-f). */
const sourceOf = (r: Row, defaultLang: string) => (r['sourceLang'] as string | null) ?? defaultLang;

const categoryView = (r: Row, defaultLang: string, platformId: string): CategoryView => ({
  id: r['id'] as string,
  tenantId: r['tenantId'] as string,
  platform: r['tenantId'] === platformId,
  parentId: (r['parentId'] as string | null | undefined) ?? null,
  key: r['key'] as string,
  nameKey: r['nameKey'] as string,
  sourceLang: sourceOf(r, defaultLang),
  isActive: r['isActive'] as boolean,
  archivedAt: (r['archivedAt'] as Date | null | undefined) ?? null,
});

const capabilityView = (r: Row, defaultLang: string, platformId: string): CapabilityView => ({
  id: r['id'] as string,
  tenantId: r['tenantId'] as string,
  platform: r['tenantId'] === platformId,
  key: r['key'] as string,
  nameKey: r['nameKey'] as string,
  descriptionKey: (r['descriptionKey'] as string | null) ?? null,
  sourceLang: sourceOf(r, defaultLang),
});

const productView = (r: Row, defaultLang: string, platformId: string, categoryIds: string[]): ProductView => ({
  id: r['id'] as string,
  tenantId: r['tenantId'] as string,
  platform: r['tenantId'] === platformId,
  categoryIds,
  key: r['key'] as string,
  nameKey: r['nameKey'] as string,
  descriptionKey: (r['descriptionKey'] as string | null) ?? null,
  sourceLang: sourceOf(r, defaultLang),
  fulfilmentKind: r['fulfilmentKind'] as FulfilmentKind,
  featureKeys: (r['featureKeys'] as string[] | undefined) ?? [],
  defaultQuotas: r['defaultQuotas'] ?? {},
  isActive: r['isActive'] as boolean,
  archivedAt: (r['archivedAt'] as Date | null | undefined) ?? null,
});

/**
 * The currency a new price is written in (F-116-d, ADR-0098 part 2): its
 * tenant's operating currency, the platform's for a platform row. An amount is
 * never converted on the way in — the admin typed it in that currency.
 */
const pricingCurrencyOf = (tx: Prisma.TransactionClient, tenantId: string) => operatingCurrencyOf(tx, tenantId);

const priceView = (r: Row): PriceView => ({
  id: r['id'] as string,
  variantId: r['variantId'] as string,
  amount: new Prisma.Decimal(r['amount'] as Prisma.Decimal.Value).toFixed(2),
  currencyCode: r['currencyCode'] as string,
  effectiveFrom: r['effectiveFrom'] as Date,
  isActive: r['isActive'] as boolean,
});

const rateCardView = (r: Row): RateCardView => ({
  id: r['id'] as string,
  variantId: r['variantId'] as string,
  meterKey: r['meterKey'] as string,
  unitSize: String(r['unitSize']),
  unitPrice: new Prisma.Decimal(r['unitPrice'] as Prisma.Decimal.Value).toString(),
  currencyCode: r['currencyCode'] as string,
  mode: r['mode'] as RateCardMode,
  includedQuantity: String(r['includedQuantity'] ?? 0),
  afterIncluded: r['afterIncluded'] as RateCardAfterIncluded,
  effectiveFrom: r['effectiveFrom'] as Date,
  isActive: r['isActive'] as boolean,
});

const newestFirst = <T extends { effectiveFrom: Date }>(rows: T[]) => rows.sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime());

const variantView = (r: Row, platformId: string, prices: Row[], cards: Row[] = []): VariantView => ({
  id: r['id'] as string,
  tenantId: r['tenantId'] as string,
  platform: r['tenantId'] === platformId,
  productId: r['productId'] as string,
  sku: r['sku'] as string,
  nameKey: (r['nameKey'] as string | null) ?? null,
  quotas: r['quotas'] ?? {},
  durationDays: (r['durationDays'] as number | null) ?? null,
  billingMode: r['billingMode'] as VariantBillingMode,
  visibility: r['visibility'] as VariantVisibility,
  panelGroupId: (r['panelGroupId'] as string | null) ?? null,
  qualityTier: r['qualityTier'] as QualityTier,
  isActive: r['isActive'] as boolean,
  prices: newestFirst(prices.map(priceView)),
  rateCards: newestFirst(cards.map(rateCardView)),
});

/** The row a text key names, and how a review of it is refused and audited. */
const TEXT_ITEMS = {
  category: { model: 'productCategory', missing: 'category_not_found', action: 'catalog_category_update', target: 'product_category' },
  product: { model: 'product', missing: 'product_not_found', action: 'catalog_product_update', target: 'product' },
  capability: { model: 'productCapability', missing: 'capability_not_found', action: 'catalog_capability_update', target: 'product_capability' },
} as const satisfies Record<
  CatalogTextKind,
  {
    model: 'productCategory' | 'product' | 'productCapability';
    missing: CatalogAdminRejection;
    action: Prisma.AdminAuditLogUncheckedCreateInput['action'];
    target: Prisma.AdminAuditLogUncheckedCreateInput['targetEntityType'];
  }
>;

type DraftRequest = { key: string; from: string; text: string; written: string[] };

/** What to draft for one text: from its source language, into every language not written. */
const drafts = (key: string, from: string, text: Texts): DraftRequest[] =>
  text[from] ? [{ key, from, text: text[from], written: Object.keys(text) }] : [];

@Injectable()
export class CatalogAdminService {
  private readonly logger = new Logger(CatalogAdminService.name);

  constructor(
    /** Who is asking, and a tenant admin's every catalog query. */
    private readonly prisma: PrismaService,
    /** The platform owner's pool. See the class comment. */
    private readonly all: CrossTenantPrismaService,
    /** fa/en publish and the drafts of every other language (F-1533-d). */
    private readonly texts: CatalogTextService,
  ) {}

  private platform: Promise<string> | null = null;

  /** The platform's tenant id (ADR-0142), read once; a failed read is asked again. */
  private platformId(): Promise<string> {
    // The app pool: `tenant` has no RLS, and a reseller's request never touches the owner's pool (ADR-0053).
    this.platform ??= platformTenantIdOf(this.prisma).catch((e: unknown) => {
      this.platform = null;
      throw e;
    });
    return this.platform;
  }

  /** The owner a text key is built for: none for the platform's, so its keys stay `catalog.<kind>.<key>.*`. */
  private async keyOwner(tenantId: string): Promise<string | null> {
    return tenantId === (await this.platformId()) ? null : tenantId;
  }

  /** Whether the caller is the platform owner. */
  async access(actor: CatalogActor): Promise<{ owner: boolean }> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: actor.tenantId }, select: { tenantType: true } });
    return { owner: isPlatformTenant(tenant?.tenantType) };
  }

  /** Run `fn` in one transaction on the pool that serves this caller (ADR-0053). */
  /**
   * A variant is provisioned on a platform panel group or its own tenant's
   * (F-027-bk); any other is not found, as another tenant's variant is. The
   * database refuses the same (`product_variant_panel_group_fits`) — this is
   * the refusal the caller can read.
   */
  private async usableGroup(db: Prisma.TransactionClient, id: string | null | undefined, tenantId: string): Promise<void> {
    if (!id) return;
    const group = await db.panelGroup.findUnique({ where: { id }, select: { tenantId: true } });
    if (!group || (group.tenantId !== null && group.tenantId !== tenantId)) throw new CatalogAdminRefused('panel_group_not_found', id);
  }

  private within<T>(owner: boolean, fn: (db: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return owner ? this.all.$transaction(fn) : tenantTransaction(this.prisma, fn);
  }

  /**
   * Whose a new item is. Absent = the caller's tenant — the platform's for its
   * staff (ADR-0142); another tenant = the owner's alone.
   */
  async ownerOfNew(actor: CatalogActor, requested: string | undefined): Promise<string> {
    const tenantId = requested ?? actor.tenantId;
    if (tenantId === actor.tenantId) return tenantId;
    const { owner } = await this.access(actor);
    if (!owner) throw new CatalogAdminRefused('not_platform_owner', "another tenant's item");
    if (!(await this.all.tenant.findUnique({ where: { id: tenantId }, select: { id: true } }))) {
      throw new CatalogAdminRefused('tenant_not_found', tenantId);
    }
    return tenantId;
  }

  /**
   * The currency a new price or rate card on this owner's rows is written in
   * (F-116-h10a, ADR-0098): what a form names beside the amount. Whose row is
   * `ownerOfNew`'s, so a caller learns only the code of rows it may price.
   */
  async pricingCurrency(actor: CatalogActor, requested: string | undefined): Promise<{ code: string }> {
    const tenantId = await this.ownerOfNew(actor, requested);
    const { owner } = await this.access(actor);
    return { code: await this.within(owner, (tx) => pricingCurrencyOf(tx, tenantId)) };
  }

  // -------------------------------------------------------------- panel groups

  /**
   * The panel groups a variant may name (F-026-p): the platform's and the
   * caller's own, or every group for the platform owner — each with its
   * `tenantId`, so a client offers a variant only the platform's and its own
   * tenant's, as {@link usableGroup} admits. `healthyMembers` counts what
   * fulfilment would place on now (`placeableMember`); `strategy` is shown,
   * because only `mirror` is fulfilled (network `contract.groups.md` rule 7);
   * `protocols` is what its members' inbounds sell — each its own, else the
   * panel's pool (F-114-b, F-027-ch).
   */
  async listPanelGroups(actor: CatalogActor): Promise<PanelGroupOption[]> {
    const { owner } = await this.access(actor);
    const rows = await this.within(owner, (db) =>
      db.panelGroup.findMany({
        where: owner ? {} : { OR: [{ tenantId: null }, { tenantId: actor.tenantId }] },
        select: {
          id: true,
          tenantId: true,
          name: true,
          strategy: true,
          members: {
            select: {
              role: true,
              // Its own inbounds replace the pool (F-027-ch): `sellingInbounds` picks which it sells.
              inbounds: { select: { inbound: { select: { remoteId: true, protocol: true, maxClients: true, enabled: true, goneAt: true } } } },
              panel: {
                select: {
                  reviewState: true,
                  panelState: true,
                  inbounds: {
                    where: { sold: true, enabled: true, goneAt: null, protocol: { not: null }, assignment: { is: null } },
                    select: { remoteId: true, protocol: true, maxClients: true },
                  },
                },
              },
            },
          },
        },
        orderBy: { name: 'asc' },
      }),
    );
    return rows.map(({ members, ...g }) => ({
      ...g,
      protocols: [...new Set(members.flatMap((m) => sellingInbounds(m).map((i) => i.protocol)))].sort(),
      healthyMembers: members.filter(placeableMember).length,
    }));
  }

  // ---------------------------------------------------------------- categories

  async listCategories(actor: CatalogActor, filter: ListCategoriesFilter = {}): Promise<CategoryView[]> {
    const { owner } = await this.access(actor);
    // A tenant sees the platform's shared categories beside its own: it files products in either.
    const archivedAt = filter.archived ? { not: null } : null;
    const pid = await this.platformId();
    const rows = await this.within(owner, (db) =>
      db.productCategory.findMany({
        where: owner ? { archivedAt } : { OR: [{ tenantId: pid }, { tenantId: actor.tenantId }], archivedAt },
        orderBy: { key: 'asc' },
      }),
    );
    return (rows as unknown as Row[]).map((r) => categoryView(r, this.texts.defaultLanguage(), pid));
  }

  async createCategory(actor: CatalogActor, input: CreateCategoryInput): Promise<CategoryView> {
    const { owner } = await this.access(actor);
    const pid = await this.platformId();
    const tenantId = await this.ownerOfNew(actor, input.tenantId);
    const sourceLang = this.sourceLang(input.sourceLang, input.name, undefined);
    const nameKey = catalogTextKey(await this.keyOwner(tenantId), 'category', input.key, 'name');
    const view = await this.within(owner, async (tx) => {
      await this.placeUnder(tx, null, tenantId, input.parentId);
      const row = (await this.refuseDuplicate('key_taken', input.key, () =>
        tx.productCategory.create({ data: { tenantId, parentId: input.parentId ?? null, key: input.key, nameKey, sourceLang } }),
      )) as unknown as Row;
      const created = categoryView(row, this.texts.defaultLanguage(), pid);
      await this.audit(tx, actor, tenantId, 'catalog_category_create', 'product_category', created.id, null, { ...created, name: input.name });
      await this.texts.publishSources([{ key: nameKey, text: input.name }]);
      return created;
    });
    if (input.translateAll) void this.texts.draftOthers(drafts(nameKey, sourceLang, input.name));
    return view;
  }

  async updateCategory(actor: CatalogActor, id: string, patch: UpdateCategoryInput): Promise<CategoryView> {
    const { owner } = await this.access(actor);
    const pid = await this.platformId();
    const renaming = patch.name !== undefined || patch.sourceLang !== undefined;
    let sourceLang: string | null = null;
    const view = await this.within(owner, async (tx) => {
      const before = await this.managed(tx, 'productCategory', 'category_not_found', actor, id, owner);
      sourceLang = renaming ? this.sourceLang(patch.sourceLang ?? sourceOf(before, this.texts.defaultLanguage()), patch.name ?? {}, undefined) : null;
      const nameKey = catalogTextKey(await this.keyOwner(before['tenantId'] as string), 'category', before['key'] as string, 'name');
      if (patch.parentId !== undefined) await this.placeUnder(tx, id, before['tenantId'] as string, patch.parentId);
      const data = {
        ...(patch.parentId !== undefined ? { parentId: patch.parentId } : {}),
        ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
        ...(renaming ? { nameKey, sourceLang } : {}),
        ...(patch.archived === false ? { archivedAt: null } : {}),
      };
      const row = (await this.refuseCycle(id, () => tx.productCategory.update({ where: { id }, data }))) as unknown as Row;
      const updated = categoryView(row, this.texts.defaultLanguage(), pid);
      await this.audit(tx, actor, updated.tenantId, 'catalog_category_update', 'product_category', id, categoryView(before, this.texts.defaultLanguage(), pid), { ...updated, name: patch.name });
      if (patch.name) await this.texts.publishSources([{ key: nameKey, text: patch.name }]);
      return updated;
    });
    if (patch.translateAll && patch.name && sourceLang) void this.texts.draftOthers(drafts(view.nameKey, sourceLang, patch.name));
    return view;
  }

  /**
   * Remove categories, each on its own (F-026-j): one no product sits in is
   * deleted; one that holds any product, an archived one included, is kept
   * and answered `has_products`. `product_category_link.categoryId` is
   * `ON DELETE RESTRICT`, so the database decides — there is no count to race
   * with a product filed in the meantime. One another category sits under is
   * kept and answered `has_children` (F-026-r): its children are moved or
   * removed first, never with it.
   */
  async removeCategories(actor: CatalogActor, ids: string[], withProducts = false): Promise<CategoryRemovalOutcome[]> {
    const { owner } = await this.access(actor);
    const outcomes: CategoryRemovalOutcome[] = [];
    for (const id of ids) {
      outcomes.push(withProducts ? await this.removeCategoryWithProducts(actor, owner, id) : { id, outcome: await this.removeCategory(actor, owner, id) });
    }
    return outcomes;
  }

  /**
   * A category and its products (F-026-l). Each product of the category's own
   * tenant is removed as `removeProducts` removes it — deleted if never sold,
   * archived if sold — then the category goes if nothing sits in it, and is
   * archived if only archived products do. Another tenant's product in the
   * platform's shared category is never touched: it keeps the category, and
   * the answer is `has_products`.
   */
  private async removeCategoryWithProducts(actor: CatalogActor, owner: boolean, id: string): Promise<CategoryRemovalOutcome> {
    let category: Row;
    let children = 0;
    try {
      category = await this.within(owner, async (db) => {
        const row = await this.managed(db, 'productCategory', 'category_not_found', actor, id, owner);
        children = await db.productCategory.count({ where: { parentId: id } });
        return row;
      });
    } catch (e) {
      if (e instanceof CatalogAdminRefused) return { id, outcome: 'not_found' };
      throw e;
    }
    // Nothing inside is touched while a category sits under it: the answer would not be a removal.
    if (children > 0) return { id, outcome: 'has_children' };
    const tenantId = category['tenantId'] as string;
    const inside = await this.within(owner, async (db) => {
      const ids = await this.productIdsIn(db, id);
      return (await db.product.findMany({ where: { id: { in: ids }, tenantId, archivedAt: null } })) as unknown as Row[];
    });
    const products = { deleted: 0, archived: 0, unlinked: 0 };
    for (const p of inside) {
      const outcome = await this.takeOutOrRemove(actor, owner, p['id'] as string, id);
      if (outcome !== 'not_found') products[outcome] += 1;
    }
    const outcome = await this.removeCategory(actor, owner, id);
    return { id, outcome: outcome === 'has_products' ? await this.archiveCategory(actor, owner, id) : outcome, products };
  }

  /**
   * A product in a category being removed with its products: one filed in
   * another category too is only taken out of this one (audited as a product
   * update) — it is still sold there; one filed here alone is removed.
   */
  private async takeOutOrRemove(actor: CatalogActor, owner: boolean, productId: string, categoryId: string): Promise<'deleted' | 'archived' | 'unlinked' | 'not_found'> {
    const pid = await this.platformId();
    const unlinked = await this.within(owner, async (tx) => {
      const before = await this.managed(tx, 'product', 'product_not_found', actor, productId, owner);
      const ids = (await this.categoryIdsOf(tx, [productId])).get(productId) ?? [];
      if (ids.length < 2) return false;
      const rest = ids.filter((c) => c !== categoryId);
      await this.fileIn(tx, productId, before['tenantId'] as string, rest);
      await this.audit(tx, actor, before['tenantId'] as string, 'catalog_product_update', 'product', productId, productView(before, this.texts.defaultLanguage(), pid, ids), {
        categoryIds: rest,
        removedWith: categoryId,
      });
      return true;
    });
    return unlinked ? 'unlinked' : this.removeProduct(actor, owner, productId);
  }

  /** Archive a category only archived products sit in; a live product in it (another tenant's, or one filed meanwhile) keeps it. */
  private async archiveCategory(actor: CatalogActor, owner: boolean, id: string): Promise<'archived' | 'has_products' | 'not_found'> {
    const pid = await this.platformId();
    try {
      return await this.within(owner, async (tx) => {
        const before = await this.managed(tx, 'productCategory', 'category_not_found', actor, id, owner);
        if ((await tx.product.count({ where: { id: { in: await this.productIdsIn(tx, id) }, archivedAt: null } })) > 0) return 'has_products' as const;
        if (before['archivedAt']) return 'archived' as const;
        const updated = await tx.productCategory.update({ where: { id }, data: { isActive: false, archivedAt: new Date() } });
        await this.audit(tx, actor, before['tenantId'] as string, 'catalog_category_archive', 'product_category', id, categoryView(before, this.texts.defaultLanguage(), pid), {
          ...categoryView(updated as unknown as Row, this.texts.defaultLanguage(), pid),
          outcome: 'archived',
        });
        return 'archived' as const;
      });
    } catch (e) {
      if (e instanceof CatalogAdminRefused) return 'not_found';
      throw e;
    }
  }

  private async removeCategory(actor: CatalogActor, owner: boolean, id: string): Promise<CategoryRemovalOutcome['outcome']> {
    const pid = await this.platformId();
    try {
      return await this.within(owner, async (tx) => {
        const before = await this.managed(tx, 'productCategory', 'category_not_found', actor, id, owner);
        if ((await tx.productCategory.count({ where: { parentId: id } })) > 0) return 'has_children' as const;
        await tx.productCategory.delete({ where: { id } });
        await this.audit(tx, actor, before['tenantId'] as string, 'catalog_category_delete', 'product_category', id, categoryView(before, this.texts.defaultLanguage(), pid), {
          outcome: 'deleted',
        });
        return 'deleted' as const;
      });
    } catch (e) {
      if (e instanceof CatalogAdminRefused) return 'not_found';
      if (isStillReferenced(e)) return 'has_products';
      throw e;
    }
  }

  // -------------------------------------------------------------- capabilities

  /** The platform's capabilities and the caller's own (owner: every one, each with its tenant). */
  async listCapabilities(actor: CatalogActor): Promise<CapabilityView[]> {
    const { owner } = await this.access(actor);
    const pid = await this.platformId();
    const rows = await this.within(owner, (db) =>
      db.productCapability.findMany({ where: owner ? {} : { OR: [{ tenantId: pid }, { tenantId: actor.tenantId }] }, orderBy: { key: 'asc' } }),
    );
    return (rows as unknown as Row[]).map((r) => capabilityView(r, this.texts.defaultLanguage(), pid));
  }

  /**
   * A key is unique among what one tenant sees: a tenant's may not repeat the
   * platform's, and the platform's may not repeat any tenant's — else a tenant
   * would see one key twice. `key_taken` either way.
   */
  async createCapability(actor: CatalogActor, input: CreateCapabilityInput): Promise<CapabilityView> {
    const { owner } = await this.access(actor);
    const pid = await this.platformId();
    const tenantId = await this.ownerOfNew(actor, input.tenantId);
    const sourceLang = this.sourceLang(input.sourceLang, input.name, input.description);
    const texts = this.itemTexts('capability', await this.keyOwner(tenantId), input.key, sourceLang, input.name, input.description);
    const view = await this.within(owner, async (tx) => {
      const clash = await tx.productCapability.findFirst({ where: tenantId === pid ? { key: input.key } : { key: input.key, OR: [{ tenantId: pid }, { tenantId }] } });
      if (clash) throw new CatalogAdminRefused('key_taken', input.key);
      const row = (await this.refuseDuplicate('key_taken', input.key, () =>
        tx.productCapability.create({
          data: { tenantId, key: input.key, nameKey: texts.nameKey, descriptionKey: input.description ? texts.descriptionKey : null, sourceLang },
        }),
      )) as unknown as Row;
      const created = capabilityView(row, this.texts.defaultLanguage(), pid);
      await this.audit(tx, actor, tenantId, 'catalog_capability_create', 'product_capability', created.id, null, {
        ...created,
        name: input.name,
        description: input.description ?? null,
      });
      await this.texts.publishSources(texts.publish);
      await this.texts.clear(texts.clear);
      return created;
    });
    if (input.translateAll) void this.texts.draftOthers(texts.draft);
    return view;
  }

  /** Name and description only: the key is held as a string by products and Grants, so it never changes. */
  async updateCapability(actor: CatalogActor, id: string, patch: UpdateCapabilityInput): Promise<CapabilityView> {
    const { owner } = await this.access(actor);
    const pid = await this.platformId();
    const renaming = patch.name !== undefined || patch.sourceLang !== undefined;
    let draft: DraftRequest[] = [];
    const view = await this.within(owner, async (tx) => {
      const before = await this.managed(tx, 'productCapability', 'capability_not_found', actor, id, owner);
      const current = sourceOf(before, this.texts.defaultLanguage());
      const sourceLang =
        renaming || patch.description ? this.sourceLang(patch.sourceLang ?? current, patch.name ?? (renaming ? {} : undefined), patch.description) : current;
      const texts = this.itemTexts('capability', await this.keyOwner(before['tenantId'] as string), before['key'] as string, sourceLang, patch.name, patch.description);
      draft = texts.draft;
      const data = {
        ...(renaming ? { nameKey: texts.nameKey, sourceLang } : {}),
        ...(patch.description !== undefined ? { descriptionKey: patch.description ? texts.descriptionKey : null } : {}),
      };
      const updated = capabilityView((await tx.productCapability.update({ where: { id }, data })) as unknown as Row, this.texts.defaultLanguage(), pid);
      await this.audit(tx, actor, updated.tenantId, 'catalog_capability_update', 'product_capability', id, capabilityView(before, this.texts.defaultLanguage(), pid), {
        ...updated,
        name: patch.name,
        description: patch.description,
      });
      await this.texts.publishSources(texts.publish);
      await this.texts.clear(texts.clear);
      return updated;
    });
    if (patch.translateAll) void this.texts.draftOthers(draft);
    return view;
  }

  /**
   * Deleted only while no product and no Grant holds its key
   * (`capability_in_use`) — a platform capability counted across every tenant.
   * The row is locked first, so a product write naming it either finished
   * before the count or finds it gone ({@link knownCapabilities}).
   */
  async removeCapability(actor: CatalogActor, id: string): Promise<{ id: string; outcome: 'deleted' }> {
    const { owner } = await this.access(actor);
    const pid = await this.platformId();
    const gone = await this.within(owner, async (tx) => {
      const before = await this.managed(tx, 'productCapability', 'capability_not_found', actor, id, owner);
      await tx.$executeRaw`SELECT 1 FROM "catalog"."product_capability" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const tenantId = before['tenantId'] as string;
      const held = { ...(tenantId === pid ? {} : { tenantId }), featureKeys: { has: before['key'] as string } };
      if ((await tx.product.count({ where: held })) + (await tx.grant.count({ where: held })) > 0) {
        throw new CatalogAdminRefused('capability_in_use', before['key'] as string);
      }
      await tx.productCapability.delete({ where: { id } });
      await this.audit(tx, actor, tenantId, 'catalog_capability_delete', 'product_capability', id, capabilityView(before, this.texts.defaultLanguage(), pid), { outcome: 'deleted' });
      return capabilityView(before, this.texts.defaultLanguage(), pid);
    });
    // The row is gone; a text left behind costs nothing but a stale name if the key is reused.
    await this.texts.clear([gone.nameKey, ...(gone.descriptionKey ? [gone.descriptionKey] : [])]).catch((e: unknown) => this.logger.warn(`capability texts kept: ${String(e)}`));
    return { id, outcome: 'deleted' };
  }

  /**
   * Every key must be a capability `tenantId`'s product can carry: the
   * platform's or that tenant's own (`capability_unknown`). The rows are
   * locked `FOR SHARE` until the write commits, so a delete waits for it and
   * then counts this product.
   */
  private async knownCapabilities(db: Prisma.TransactionClient, tenantId: string, keys: string[] | undefined): Promise<void> {
    const wanted = [...new Set(keys ?? [])];
    if (wanted.length === 0) return;
    const pid = await this.platformId();
    await db.$executeRaw`SELECT 1 FROM "catalog"."product_capability" WHERE "key" = ANY(${wanted}) AND ("tenantId" = ${pid}::uuid OR "tenantId" = ${tenantId}::uuid) FOR SHARE`;
    const seen = await db.productCapability.findMany({ where: { key: { in: wanted }, OR: [{ tenantId: pid }, { tenantId }] }, select: { key: true } });
    const missing = wanted.filter((k) => !seen.some((c) => c.key === k));
    if (missing.length > 0) throw new CatalogAdminRefused('capability_unknown', missing.join(', '));
  }

  // ------------------------------------------------------------------ products

  async listProducts(actor: CatalogActor, filter: ListProductsFilter = {}): Promise<AudiencedProductView[]> {
    const { owner } = await this.access(actor);
    const pid = await this.platformId();
    const tenant = owner ? (filter.tenantId === 'platform' ? pid : filter.tenantId) : actor.tenantId;
    return this.within(owner, async (db) => {
      const rows = (await db.product.findMany({
        where: {
          ...(tenant === undefined ? {} : { tenantId: tenant }),
          ...(filter.categoryId ? { id: { in: await this.productIdsIn(db, filter.categoryId) } } : {}),
          archivedAt: filter.archived ? { not: null } : null,
        },
        orderBy: { key: 'asc' },
      })) as unknown as Row[];
      const ids = rows.map((r) => r['id'] as string);
      const [categories, audience] = await Promise.all([this.categoryIdsOf(db, ids), this.audienceOf(db, ids)]);
      return rows.map((r) => ({
        ...productView(r, this.texts.defaultLanguage(), pid, categories.get(r['id'] as string) ?? []),
        userGroupIds: audience.get(r['id'] as string) ?? [],
      }));
    });
  }

  /** A product with its variants and each variant's whole price and rate card history. */
  async getProduct(actor: CatalogActor, id: string): Promise<AudiencedProductView & { variants: VariantView[] }> {
    const { owner } = await this.access(actor);
    const pid = await this.platformId();
    return this.within(owner, async (db) => {
      const product = await this.managed(db, 'product', 'product_not_found', actor, id, owner);
      const variants = (await db.productVariant.findMany({ where: { productId: id }, orderBy: { sku: 'asc' } })) as unknown as Row[];
      const withPrices: VariantView[] = [];
      for (const v of variants) {
        const variantId = v['id'] as string;
        const prices = (await db.price.findMany({ where: { variantId } })) as unknown as Row[];
        withPrices.push(variantView(v, pid, prices, (await db.rateCard.findMany({ where: { variantId } })) as unknown as Row[]));
      }
      const [categories, audience] = await Promise.all([this.categoryIdsOf(db, [id]), this.audienceOf(db, [id])]);
      return {
        ...productView(product, this.texts.defaultLanguage(), pid, categories.get(id) ?? []),
        userGroupIds: audience.get(id) ?? [],
        variants: withPrices,
      };
    });
  }

  async createProduct(actor: CatalogActor, input: CreateProductInput): Promise<ProductView> {
    const { owner } = await this.access(actor);
    const pid = await this.platformId();
    const tenantId = await this.ownerOfNew(actor, input.tenantId);
    const sourceLang = this.sourceLang(input.sourceLang, input.name, input.description);
    const texts = this.itemTexts('product', await this.keyOwner(tenantId), input.key, sourceLang, input.name, input.description);
    const view = await this.within(owner, async (tx) => {
      await this.usableCategories(tx, input.categoryIds, tenantId);
      await this.knownCapabilities(tx, tenantId, input.featureKeys);
      const row = (await this.refuseDuplicate('key_taken', input.key, () =>
        tx.product.create({
          data: {
            tenantId,
            key: input.key,
            nameKey: texts.nameKey,
            descriptionKey: input.description ? texts.descriptionKey : null,
            sourceLang,
            fulfilmentKind: input.fulfilmentKind,
            featureKeys: input.featureKeys ?? [],
            defaultQuotas: (input.defaultQuotas ?? {}) as Prisma.InputJsonValue,
          },
        }),
      )) as unknown as Row;
      await this.fileIn(tx, row['id'] as string, tenantId, input.categoryIds);
      const created = productView(row, this.texts.defaultLanguage(), pid, input.categoryIds);
      await this.audit(tx, actor, tenantId, 'catalog_product_create', 'product', created.id, null, {
        ...created,
        name: input.name,
        description: input.description ?? null,
      });
      await this.texts.publishSources(texts.publish);
      await this.texts.clear(texts.clear);
      return created;
    });
    if (input.translateAll) void this.texts.draftOthers(texts.draft);
    return view;
  }

  /** The key and fulfilment kind stay: a key is referenced by string, and a Grant's handler by its kind. */
  async updateProduct(actor: CatalogActor, id: string, patch: UpdateProductInput): Promise<ProductView> {
    const { owner } = await this.access(actor);
    const pid = await this.platformId();
    const renaming = patch.name !== undefined || patch.sourceLang !== undefined;
    let draft: DraftRequest[] = [];
    const view = await this.within(owner, async (tx) => {
      const before = await this.managed(tx, 'product', 'product_not_found', actor, id, owner);
      const tenantId = before['tenantId'] as string;
      const categoriesBefore = (await this.categoryIdsOf(tx, [id])).get(id) ?? [];
      if (patch.categoryIds) await this.usableCategories(tx, patch.categoryIds, tenantId);
      await this.knownCapabilities(tx, tenantId, patch.featureKeys);
      const current = sourceOf(before, this.texts.defaultLanguage());
      const sourceLang =
        renaming || patch.description ? this.sourceLang(patch.sourceLang ?? current, patch.name ?? (renaming ? {} : undefined), patch.description) : current;
      const texts = this.itemTexts('product', await this.keyOwner(before['tenantId'] as string), before['key'] as string, sourceLang, patch.name, patch.description);
      draft = texts.draft;
      const data: Prisma.ProductUpdateInput = {
        ...(renaming ? { nameKey: texts.nameKey, sourceLang } : {}),
        ...(patch.description !== undefined ? { descriptionKey: patch.description ? texts.descriptionKey : null } : {}),
        ...(patch.featureKeys !== undefined ? { featureKeys: patch.featureKeys } : {}),
        ...(patch.defaultQuotas !== undefined ? { defaultQuotas: patch.defaultQuotas as Prisma.InputJsonValue } : {}),
        ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
        ...(patch.archived === false ? { archivedAt: null } : {}),
      };
      if (patch.categoryIds) await this.fileIn(tx, id, tenantId, patch.categoryIds);
      const updated = productView((await tx.product.update({ where: { id }, data })) as unknown as Row, this.texts.defaultLanguage(), pid, patch.categoryIds ?? categoriesBefore);
      if (patch.archived === false) for (const categoryId of updated.categoryIds) await this.restoreCategory(tx, actor, categoryId);
      await this.audit(tx, actor, updated.tenantId, 'catalog_product_update', 'product', id, productView(before, this.texts.defaultLanguage(), pid, categoriesBefore), {
        ...updated,
        name: patch.name,
        description: patch.description,
      });
      await this.texts.publishSources(texts.publish);
      await this.texts.clear(texts.clear);
      return updated;
    });
    if (patch.translateAll) void this.texts.draftOthers(draft);
    return view;
  }

  /**
   * Who may buy a product (PT-1-b, ADR-0142 (4)): replaces the set of groups it
   * is sold to; `[]` = every user again. Each group must be the **product's**
   * tenant's — a group of anyone else is `group_not_found` before anything is
   * written (the composite key refuses the same) — and one the caller may pick,
   * else `audience_not_allowed` (ADR-0143), unless the product already had it. Only new sales close: a Grant
   * already sold is untouched. Audited as `catalog_product_update`.
   */
  async setProductAudience(actor: CatalogActor, id: string, groupIds: string[]): Promise<{ userGroupIds: string[] }> {
    const { owner } = await this.access(actor);
    const ids = [...new Set(groupIds)];
    return this.within(owner, async (tx) => {
      const product = await this.managed(tx, 'product', 'product_not_found', actor, id, owner);
      const tenantId = product['tenantId'] as string;
      const before = (await this.audienceOf(tx, [id])).get(id) ?? [];
      const refused = await refusedAudienceGroup(tx, actor.permissions, ids, { kept: before, tenantId });
      if (refused) throw new CatalogAdminRefused(refused.reason, refused.groupId);
      await tx.productAudience.deleteMany({ where: { productId: id } });
      if (ids.length > 0) await tx.productAudience.createMany({ data: ids.map((groupId) => ({ productId: id, tenantId, groupId })) });
      await this.audit(tx, actor, tenantId, 'catalog_product_update', 'product', id, { userGroupIds: before }, { userGroupIds: ids });
      return { userGroupIds: ids };
    });
  }

  /** The groups each product is sold to, by product id (PT-1-b); none = every user. */
  private async audienceOf(db: Prisma.TransactionClient, productIds: string[]): Promise<Map<string, string[]>> {
    const byProduct = new Map<string, string[]>(productIds.map((id) => [id, []]));
    if (productIds.length === 0) return byProduct;
    const rows = await db.productAudience.findMany({ where: { productId: { in: productIds } }, orderBy: { createdAt: 'asc' }, select: { productId: true, groupId: true } });
    for (const r of rows) byProduct.get(r.productId)?.push(r.groupId);
    return byProduct;
  }

  /**
   * Remove products, each on its own (F-026-h): a product the database lets go
   * is deleted with its variants, whose prices and metered rates go with them
   * (`ON DELETE CASCADE`, and the history triggers allow exactly that). One that
   * anything references — a Grant, a coupon, a coupon scope — is archived
   * instead: switched off, out of the list, every Grant of it untouched. The
   * foreign keys decide "was it sold", so a table that references a variant
   * tomorrow is counted without a change here.
   */
  async removeProducts(actor: CatalogActor, ids: string[]): Promise<RemovalOutcome[]> {
    const { owner } = await this.access(actor);
    const outcomes: RemovalOutcome[] = [];
    for (const id of ids) outcomes.push({ id, outcome: await this.removeProduct(actor, owner, id) });
    return outcomes;
  }

  private async removeProduct(actor: CatalogActor, owner: boolean, id: string): Promise<RemovalOutcome['outcome']> {
    const pid = await this.platformId();
    try {
      return await this.within(owner, async (tx) => {
        const before = await this.managed(tx, 'product', 'product_not_found', actor, id, owner);
        const variants = (await tx.productVariant.findMany({ where: { productId: id } })) as unknown as Row[];
        await tx.productVariant.deleteMany({ where: { productId: id } });
        const categories = (await this.categoryIdsOf(tx, [id])).get(id) ?? [];
        await tx.product.delete({ where: { id } });
        await this.audit(tx, actor, before['tenantId'] as string, 'catalog_product_delete', 'product', id, productView(before, this.texts.defaultLanguage(), pid, categories), {
          outcome: 'deleted',
          variants: variants.map((v) => v['sku']),
        });
        return 'deleted' as const;
      });
    } catch (e) {
      if (e instanceof CatalogAdminRefused) return 'not_found';
      // Postgres aborted that transaction, so the archive is a second one.
      if (!isStillReferenced(e)) throw e;
    }
    return this.within(owner, async (tx) => {
      const before = await this.managed(tx, 'product', 'product_not_found', actor, id, owner);
      if (before['archivedAt']) return 'archived' as const;
      const categories = (await this.categoryIdsOf(tx, [id])).get(id) ?? [];
      const updated = await tx.product.update({ where: { id }, data: { isActive: false, archivedAt: new Date() } });
      await this.audit(tx, actor, before['tenantId'] as string, 'catalog_product_archive', 'product', id, productView(before, this.texts.defaultLanguage(), pid, categories), {
        ...productView(updated as unknown as Row, this.texts.defaultLanguage(), pid, categories),
        outcome: 'archived',
      });
      return 'archived' as const;
    });
  }

  /** A product back from the archive brings each archived category it sits in back too, still switched off (F-026-l). */
  private async restoreCategory(tx: Prisma.TransactionClient, actor: CatalogActor, categoryId: string): Promise<void> {
    const pid = await this.platformId();
    const before = (await tx.productCategory.findUnique({ where: { id: categoryId } })) as unknown as Row | null;
    if (!before?.['archivedAt']) return;
    const row = (await tx.productCategory.update({ where: { id: categoryId }, data: { archivedAt: null } })) as unknown as Row;
    await this.audit(tx, actor, before['tenantId'] as string, 'catalog_category_update', 'product_category', categoryId, categoryView(before, this.texts.defaultLanguage(), pid), {
      ...categoryView(row, this.texts.defaultLanguage(), pid),
      restoredWith: 'product',
    });
  }

  // -------------------------------------------------------------- translations

  /** Drafts waiting for review — every key for the platform owner, a tenant's own otherwise. */
  async listTextDrafts(actor: CatalogActor, lang?: string): Promise<ReviewItem[]> {
    return this.texts.reviewList(await this.textSourcesOf(actor), lang);
  }

  /** "Translate missing": drafts the caller's text into every language that has neither text nor a draft. */
  async draftMissingTexts(actor: CatalogActor): Promise<{ drafted: number }> {
    const sources = await this.textSourcesOf(actor);
    return { drafted: await this.texts.draftMissing([...sources].map(([key, from]) => ({ key, from }))) };
  }

  /** Publishes drafts as they are. Audited on each item whose text it is. */
  async publishTextDrafts(actor: CatalogActor, input: PublishTextsInput): Promise<{ published: number }> {
    return this.publishingTexts(actor, input.lang, input.keys, { published: input.keys }, () => this.texts.publishDrafts(input.lang, input.keys));
  }

  /** Publishes a reviewer's own text for a language, in place of any draft. */
  async editTexts(actor: CatalogActor, input: EditTextsInput): Promise<{ published: number }> {
    return this.publishingTexts(actor, input.lang, Object.keys(input.texts), { edited: input.texts }, () =>
      this.texts.publishEdited(input.lang, input.texts),
    );
  }

  // ------------------------------------------------------------------ variants

  /** A variant takes its product's tenant, and is written with its first price. */
  async createVariant(actor: CatalogActor, productId: string, input: CreateVariantInput): Promise<VariantView> {
    const { owner } = await this.access(actor);
    const pid = await this.platformId();
    const effectiveFrom = this.effectiveFrom(input.effectiveFrom);

    return this.within(owner, async (tx) => {
      const product = await this.managed(tx, 'product', 'product_not_found', actor, productId, owner);
      const tenantId = product['tenantId'] as string;
      await this.usableGroup(tx, input.panelGroupId, tenantId);
      const quotas = input.quotas ?? product['defaultQuotas'] ?? {};
      this.refuseUnstatedTraffic(product['fulfilmentKind'] as FulfilmentKind, input.billingMode, quotas, input.sku);
      if (input.rateCard) await this.refuseUnserved(tx, input.billingMode, input.rateCard);
      const variant = (await this.refuseDuplicate('sku_taken', input.sku, () =>
        tx.productVariant.create({
          data: {
            tenantId,
            productId,
            sku: input.sku,
            nameKey: input.nameKey ?? null,
            quotas: quotas as Prisma.InputJsonValue,
            durationDays: input.durationDays ?? null,
            billingMode: input.billingMode,
            visibility: input.visibility,
            panelGroupId: input.panelGroupId ?? null,
            qualityTier: input.qualityTier ?? QualityTier.standard,
          },
        }),
      )) as unknown as Row;
      const price = (await tx.price.create({
        data: {
          tenantId,
          variantId: variant['id'] as string,
          amount: new Prisma.Decimal(input.price),
          currencyCode: await pricingCurrencyOf(tx, tenantId),
          effectiveFrom,
          createdByAdminId: actor.adminId,
        },
      })) as unknown as Row;
      const card = input.rateCard
        ? await this.writeRateCard(tx, actor, tenantId, variant['id'] as string, input.rateCard, effectiveFrom)
        : null;
      const view = variantView(variant, pid, [price], card ? [card] : []);
      await this.audit(tx, actor, tenantId, 'catalog_variant_create', 'product_variant', view.id, null, view);
      return view;
    });
  }

  /** The SKU and billing mode stay: a link names the SKU, and a Grant copied the mode. */
  async updateVariant(actor: CatalogActor, id: string, patch: UpdateVariantInput): Promise<VariantView> {
    const { owner } = await this.access(actor);
    const pid = await this.platformId();
    return this.within(owner, async (tx) => {
      const before = await this.managed(tx, 'productVariant', 'variant_not_found', actor, id, owner);
      await this.usableGroup(tx, patch.panelGroupId, before['tenantId'] as string);
      // Asked only of an edit that writes quotas: a row made before F-111-p is
      // left to the shop's refusal, not locked against every other edit.
      if (patch.quotas !== undefined) {
        const product = await tx.product.findUnique({ where: { id: before['productId'] as string }, select: { fulfilmentKind: true } });
        this.refuseUnstatedTraffic(product?.fulfilmentKind ?? null, before['billingMode'] as VariantBillingMode, patch.quotas, before['sku'] as string);
      }
      const data: Prisma.ProductVariantUpdateInput = {
        ...(patch.nameKey !== undefined ? { nameKey: patch.nameKey } : {}),
        ...(patch.quotas !== undefined ? { quotas: patch.quotas as Prisma.InputJsonValue } : {}),
        ...(patch.durationDays !== undefined ? { durationDays: patch.durationDays } : {}),
        ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}),
        ...(patch.panelGroupId !== undefined ? { panelGroupId: patch.panelGroupId } : {}),
        ...(patch.qualityTier !== undefined ? { qualityTier: patch.qualityTier } : {}),
        ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
      };
      const row = (await tx.productVariant.update({ where: { id }, data })) as unknown as Row;
      const prices = (await tx.price.findMany({ where: { variantId: id } })) as unknown as Row[];
      const cards = (await tx.rateCard.findMany({ where: { variantId: id } })) as unknown as Row[];
      const view = variantView(row, pid, prices, cards);
      await this.audit(tx, actor, view.tenantId, 'catalog_variant_update', 'product_variant', id, variantView(before, pid, []), {
        ...view,
        prices: undefined,
        rateCards: undefined,
      });
      return view;
    });
  }

  // -------------------------------------------------------------------- prices

  /** A price change is a new row from `effectiveFrom` (default now) on; the old row is never touched. */
  async setPrice(actor: CatalogActor, variantId: string, input: SetPriceInput): Promise<PriceView> {
    const { owner } = await this.access(actor);
    const effectiveFrom = this.effectiveFrom(input.effectiveFrom);
    return this.within(owner, async (tx) => {
      const variant = await this.managed(tx, 'productVariant', 'variant_not_found', actor, variantId, owner);
      const tenantId = variant['tenantId'] as string;
      // F-503-a: a campaign's restore row would undo a price written before its end.
      await this.lockCampaigns(tx, variantId);
      const verdict = priceWriteVerdict(effectiveFrom, await this.liveCampaigns(tx, variantId));
      if ('refused' in verdict) throw new CatalogAdminRefused(verdict.refused, variantId);
      const row = (await tx.price.create({
        data: {
          tenantId,
          variantId,
          amount: new Prisma.Decimal(input.amount),
          currencyCode: await pricingCurrencyOf(tx, tenantId),
          effectiveFrom,
          createdByAdminId: actor.adminId,
        },
      })) as unknown as Row;
      const view = priceView(row);
      await this.audit(tx, actor, tenantId, 'catalog_price_set', 'price', view.id, null, view);
      return view;
    });
  }

  /** Switches a price off. The row stays: it is what an invoice issued under it was computed at. */
  async deactivatePrice(actor: CatalogActor, priceId: string): Promise<PriceView> {
    const { owner } = await this.access(actor);
    return this.within(owner, async (tx) => {
      const before = await this.managed(tx, 'price', 'price_not_found', actor, priceId, owner);
      // F-503-a: half a campaign switched off would leave its price, or its restore, alone.
      if (before['campaignId']) throw new CatalogAdminRefused('price_in_campaign', priceId);
      const view = priceView((await tx.price.update({ where: { id: priceId }, data: { isActive: false } })) as unknown as Row);
      await this.audit(tx, actor, before['tenantId'] as string, 'catalog_price_deactivate', 'price', priceId, priceView(before), view);
      return view;
    });
  }

  // ------------------------------------------------------- campaigns (F-503-a)

  /**
   * A time-boxed price (D-45): the campaign row and two new price rows in one
   * transaction — its amount from `startsAt`, the price in effect then back
   * from `endsAt` (`campaignPlan`). Never an edit of a price row.
   */
  async createCampaign(actor: CatalogActor, variantId: string, input: CreateCampaignInput): Promise<CampaignView> {
    const { owner } = await this.access(actor);
    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    return this.within(owner, async (tx) => {
      const variant = await this.managed(tx, 'productVariant', 'variant_not_found', actor, variantId, owner);
      const tenantId = variant['tenantId'] as string;
      return this.writeCampaign(tx, actor, { tenantId, variantId, amount: new Prisma.Decimal(input.amount), startsAt, endsAt, seasonId: null });
    });
  }

  /**
   * The one write of a campaign — by hand, or a season's occurrence (F-505-a):
   * under the variant's lock, `campaignPlan`'s rules, then the campaign and its
   * two price rows, audited. The caller has already found the variant its own.
   */
  private async writeCampaign(
    tx: Prisma.TransactionClient,
    actor: CatalogActor,
    c: { tenantId: string; variantId: string; amount: Prisma.Decimal; startsAt: Date; endsAt: Date; seasonId: string | null },
  ): Promise<CampaignView> {
    const { tenantId, variantId, amount, startsAt, endsAt, seasonId } = c;
    await this.lockCampaigns(tx, variantId);
    const currencyCode = await pricingCurrencyOf(tx, tenantId);
    const plan = campaignPlan({
      startsAt,
      endsAt,
      now: new Date(),
      currencyCode,
      prices: await tx.price.findMany({ where: { variantId } }),
      campaigns: await this.liveCampaigns(tx, variantId),
    });
    if ('refused' in plan) throw new CatalogAdminRefused(plan.refused, variantId);
    const campaign = await tx.priceCampaign.create({ data: { tenantId, variantId, amount, currencyCode, startsAt, endsAt, createdByAdminId: actor.adminId, seasonId } });
    const common = { tenantId, variantId, currencyCode, createdByAdminId: actor.adminId, campaignId: campaign.id };
    const price = await tx.price.create({ data: { ...common, amount, effectiveFrom: startsAt, campaignEndsAt: endsAt } });
    const restore = await tx.price.create({ data: { ...common, amount: plan.restore, effectiveFrom: endsAt } });
    const view = campaignView(campaign, [price, restore]);
    await this.audit(tx, actor, tenantId, 'catalog_campaign_create', 'price_campaign', campaign.id, null, view);
    return view;
  }

  /** A variant's campaigns, newest start first, cancelled ones too. */
  async listCampaigns(actor: CatalogActor, variantId: string): Promise<CampaignView[]> {
    const { owner } = await this.access(actor);
    return this.within(owner, async (tx) => {
      await this.managed(tx, 'productVariant', 'variant_not_found', actor, variantId, owner);
      const rows = await tx.priceCampaign.findMany({ where: { variantId }, include: { prices: true }, orderBy: [{ startsAt: 'desc' }, { id: 'asc' }] });
      return rows.map(({ prices, ...c }) => campaignView(c, prices));
    });
  }

  /** Before it starts only (`cancelVerdict`): the campaign is marked and both its rows switched off. A second cancel changes nothing. */
  async cancelCampaign(actor: CatalogActor, campaignId: string): Promise<CampaignView> {
    const { owner } = await this.access(actor);
    return this.within(owner, async (tx) => {
      const row = await this.managed(tx, 'priceCampaign', 'campaign_not_found', actor, campaignId, owner);
      await this.lockCampaigns(tx, row['variantId'] as string);
      const before = await tx.priceCampaign.findUniqueOrThrow({ where: { id: campaignId }, include: { prices: true } });
      const verdict = cancelVerdict(before, new Date());
      if ('refused' in verdict) throw new CatalogAdminRefused(verdict.refused, campaignId);
      if ('already' in verdict) return campaignView(before, before.prices);
      const { prices: oldPrices, ...old } = before;
      const campaign = await tx.priceCampaign.update({ where: { id: campaignId }, data: { cancelledAt: new Date() } });
      await tx.price.updateMany({ where: { campaignId }, data: { isActive: false } });
      const view = campaignView(campaign, await tx.price.findMany({ where: { campaignId } }));
      await this.audit(tx, actor, old.tenantId, 'catalog_campaign_cancel', 'price_campaign', campaignId, campaignView(old, oldPrices), view);
      return view;
    });
  }

  // ---------------------------------------------------------- seasons (F-505-a)

  /** The caller's seasons, each with its prices and its next occurrence on its tenant's clock. */
  async listSeasons(actor: CatalogActor): Promise<SeasonView[]> {
    const { owner } = await this.access(actor);
    return this.within(owner, async (tx) => {
      const rows = await tx.season.findMany({ where: { tenantId: actor.tenantId }, include: { prices: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      const zone = await this.seasonZone(tx, actor.tenantId);
      const now = new Date();
      return rows.map((s) => seasonView(s, zone, now));
    });
  }

  async createSeason(actor: CatalogActor, input: SeasonInput): Promise<SeasonView> {
    const tenantId = await this.ownerOfNew(actor, input.tenantId);
    const { owner } = await this.access(actor);
    const refusal = seasonDateRefusal(input);
    if (refusal) throw new CatalogAdminRefused(refusal, `${input.month}/${input.day}`);
    return this.within(owner, async (tx) => {
      const dated = input.kind === 'dated';
      const row = await tx.season.create({
        data: {
          tenantId,
          name: input.name.trim(),
          kind: input.kind,
          month: dated ? (input.month ?? null) : null,
          day: dated ? (input.day ?? null) : null,
          weekday: dated ? null : (input.weekday ?? null),
          startMinute: input.startMinute,
          durationMinutes: input.durationMinutes,
          createdByAdminId: actor.adminId,
        },
        include: { prices: true },
      });
      const view = seasonView(row, await this.seasonZone(tx, tenantId), new Date());
      await this.audit(tx, actor, tenantId, 'catalog_season_create', 'season', row.id, null, view);
      return view;
    });
  }

  /** Its kind is fixed; anything else may change. Switched off (`isActive: false`), it writes no more occurrences; written ones stay, cancellable as any campaign. */
  async updateSeason(actor: CatalogActor, seasonId: string, patch: SeasonPatch): Promise<SeasonView> {
    const { owner } = await this.access(actor);
    return this.within(owner, async (tx) => {
      const before = await this.managed(tx, 'season', 'season_not_found', actor, seasonId, owner);
      const kind = before['kind'] as SeasonKind;
      const dated = kind === 'dated';
      const next = { kind, month: patch.month ?? (before['month'] as number | null), day: patch.day ?? (before['day'] as number | null) };
      const refusal = seasonDateRefusal(next);
      if (refusal) throw new CatalogAdminRefused(refusal, `${next.month}/${next.day}`);
      const row = await tx.season.update({
        where: { id: seasonId },
        data: {
          ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
          ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
          ...(patch.startMinute !== undefined ? { startMinute: patch.startMinute } : {}),
          ...(patch.durationMinutes !== undefined ? { durationMinutes: patch.durationMinutes } : {}),
          ...(dated && patch.month !== undefined ? { month: patch.month } : {}),
          ...(dated && patch.day !== undefined ? { day: patch.day } : {}),
          ...(!dated && patch.weekday !== undefined ? { weekday: patch.weekday } : {}),
        },
        include: { prices: true },
      });
      const tenantId = before['tenantId'] as string;
      const view = seasonView(row, await this.seasonZone(tx, tenantId), new Date());
      await this.audit(tx, actor, tenantId, 'catalog_season_update', 'season', seasonId, before, view);
      return view;
    });
  }

  /** A season's price for one of its own tenant's variants; what each later occurrence charges. Written occurrences keep theirs. */
  async setSeasonPrice(actor: CatalogActor, seasonId: string, variantId: string, amount: string): Promise<SeasonView> {
    const { owner } = await this.access(actor);
    return this.within(owner, async (tx) => {
      const season = await this.managed(tx, 'season', 'season_not_found', actor, seasonId, owner);
      const variant = await this.managed(tx, 'productVariant', 'variant_not_found', actor, variantId, owner);
      const tenantId = season['tenantId'] as string;
      // One tenant's season prices its own variants only.
      if (variant['tenantId'] !== tenantId) throw new CatalogAdminRefused('variant_not_found', variantId);
      const value = new Prisma.Decimal(amount);
      await tx.seasonPrice.upsert({
        where: { seasonId_variantId: { seasonId, variantId } },
        create: { seasonId, variantId, tenantId, amount: value, updatedByAdminId: actor.adminId },
        update: { amount: value, updatedByAdminId: actor.adminId },
      });
      const row = await tx.season.findUniqueOrThrow({ where: { id: seasonId }, include: { prices: true } });
      const view = seasonView(row, await this.seasonZone(tx, tenantId), new Date());
      await this.audit(tx, actor, tenantId, 'catalog_season_price_set', 'season', seasonId, null, { variantId, amount: value.toFixed(2) });
      return view;
    });
  }

  async removeSeasonPrice(actor: CatalogActor, seasonId: string, variantId: string): Promise<SeasonView> {
    const { owner } = await this.access(actor);
    return this.within(owner, async (tx) => {
      const season = await this.managed(tx, 'season', 'season_not_found', actor, seasonId, owner);
      const tenantId = season['tenantId'] as string;
      await tx.seasonPrice.deleteMany({ where: { seasonId, variantId } });
      const row = await tx.season.findUniqueOrThrow({ where: { id: seasonId }, include: { prices: true } });
      const view = seasonView(row, await this.seasonZone(tx, tenantId), new Date());
      await this.audit(tx, actor, tenantId, 'catalog_season_price_remove', 'season', seasonId, { variantId }, null);
      return view;
    });
  }

  /**
   * Writes every occurrence due in the next {@link SEASON_HORIZON_DAYS} days as
   * a campaign (F-505-b's job calls it through the internal route). Every
   * tenant's, on the cross-tenant pool; each campaign in its own transaction
   * under the campaign's rules, authored by the season's creator. One refused
   * (a plain price scheduled inside it, an overlap, nothing to restore) is
   * counted and logged — never stops the rest. Safe to run twice: what is
   * written is skipped, and a race loses on `price_campaign_season_once`.
   */
  async writeUpcomingSeasons(now: Date = new Date()): Promise<{ due: number; written: number; refused: number }> {
    const seasons = await this.all.season.findMany({ where: { isActive: true }, include: { prices: { select: { variantId: true, amount: true } } } });
    const written = await this.all.priceCampaign.findMany({
      where: { seasonId: { in: seasons.map((s) => s.id) }, startsAt: { gt: now } },
      select: { seasonId: true, variantId: true, startsAt: true },
    });
    const zones = new Map<string, string>();
    for (const tenantId of new Set(seasons.map((s) => s.tenantId))) zones.set(tenantId, await this.seasonZone(this.all, tenantId));
    const due = upcomingSeasonCampaigns(seasons, (t) => zones.get(t) ?? PLATFORM_DEFAULT_TIMEZONE, now, SEASON_HORIZON_DAYS, new Set(written.map((w) => seasonCampaignKey(w.seasonId as string, w.variantId, w.startsAt))));
    let done = 0;
    let refused = 0;
    for (const c of due) {
      const season = seasons.find((s) => s.id === c.seasonId);
      const actor: CatalogActor = { adminId: season?.createdByAdminId ?? '00000000-0000-0000-0000-000000000000', tenantId: c.tenantId, ip: '127.0.0.1', permissions: [] };
      try {
        await this.all.$transaction((tx) => this.writeCampaign(tx, actor, c));
        done += 1;
      } catch (err) {
        if (isUniqueViolation(err)) continue;
        refused += 1;
        this.logger.warn(`season ${c.seasonId} not written for ${c.variantId} at ${c.startsAt.toISOString()}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { due: due.length, written: done, refused };
  }

  /** A season's clock: its tenant's zone (ADR-0108) — the platform owner's for a platform season. */
  private async seasonZone(db: Prisma.TransactionClient | CrossTenantPrismaService, tenantId: string): Promise<string> {
    const row = await db.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
    return row?.timezone ?? PLATFORM_DEFAULT_TIMEZONE;
  }

  /** One campaign or price write per variant at a time: the checks above read what the write will meet. */
  private async lockCampaigns(tx: Prisma.TransactionClient, variantId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`price_campaign:${variantId}`}))`;
  }

  private liveCampaigns(tx: Prisma.TransactionClient, variantId: string): Promise<CampaignRow[]> {
    return tx.priceCampaign.findMany({ where: { variantId, cancelledAt: null }, select: { id: true, startsAt: true, endsAt: true, cancelledAt: true } });
  }

  // ---------------------------------------------------------------- rate cards

  /**
   * A new card for one meter on a variant the caller manages, from
   * `effectiveFrom` (default now) on; the old card is never touched. A
   * platform variant's card is the platform owner's alone — to anyone else the
   * variant is not found (ADR-0105 decision 10).
   */
  async setRateCard(actor: CatalogActor, variantId: string, input: SetRateCardInput): Promise<RateCardView> {
    const { owner } = await this.access(actor);
    const effectiveFrom = this.effectiveFrom(input.effectiveFrom);
    return this.within(owner, async (tx) => {
      const variant = await this.managed(tx, 'productVariant', 'variant_not_found', actor, variantId, owner);
      await this.refuseUnserved(tx, variant['billingMode'] as VariantBillingMode, input);
      const tenantId = variant['tenantId'] as string;
      return rateCardView(await this.writeRateCard(tx, actor, tenantId, variantId, input, effectiveFrom));
    });
  }

  /** Switches a card off. The row stays: a Grant sold under it locked its terms from it. */
  async deactivateRateCard(actor: CatalogActor, rateCardId: string): Promise<RateCardView> {
    const { owner } = await this.access(actor);
    return this.within(owner, async (tx) => {
      const before = await this.managed(tx, 'rateCard', 'rate_card_not_found', actor, rateCardId, owner);
      const view = rateCardView((await tx.rateCard.update({ where: { id: rateCardId }, data: { isActive: false } })) as unknown as Row);
      await this.audit(tx, actor, before['tenantId'] as string, 'catalog_rate_card_deactivate', 'rate_card', rateCardId, rateCardView(before), view);
      return view;
    });
  }

  /**
   * A card on a meter that exists, which a sale would take (class comment):
   * `vpn.traffic` on a metered variant, in the byte engine's shape, or a
   * per-use meter the door serves (F-118-h). Any other meter has nothing that
   * refuses unfunded use, and issue would refuse the variant `meter_not_served`.
   */
  private async refuseUnserved(db: Prisma.TransactionClient, billingMode: VariantBillingMode, card: RateCardTerms): Promise<void> {
    const meter = await db.meter.findUnique({ where: { key: card.meterKey }, select: { key: true } });
    if (!meter) throw new CatalogAdminRefused('meter_not_found', card.meterKey);
    const served =
      DOOR_METERS.has(card.meterKey) ||
      (card.meterKey === METER_KEYS.vpnTraffic &&
        billingMode === VariantBillingMode.metered &&
        servedByBytes({
          mode: card.mode,
          afterIncluded: card.afterIncluded,
          unitSize: BigInt(card.unitSize),
          includedQuantity: BigInt(card.includedQuantity ?? '0'),
        }));
    if (!served) throw new CatalogAdminRefused('rate_card_not_served', card.meterKey);
  }

  /** The card row, in its tenant's operating currency as a price is (F-116-d), and its audit row. */
  private async writeRateCard(
    tx: Prisma.TransactionClient,
    actor: CatalogActor,
    tenantId: string,
    variantId: string,
    card: RateCardTerms,
    effectiveFrom: Date,
  ): Promise<Row> {
    const row = (await tx.rateCard.create({
      data: {
        tenantId,
        variantId,
        meterKey: card.meterKey,
        unitSize: BigInt(card.unitSize),
        unitPrice: new Prisma.Decimal(card.unitPrice),
        currencyCode: await pricingCurrencyOf(tx, tenantId),
        mode: card.mode,
        includedQuantity: BigInt(card.includedQuantity ?? '0'),
        afterIncluded: card.afterIncluded,
        effectiveFrom,
        createdByAdminId: actor.adminId,
      },
    })) as unknown as Row;
    const view = rateCardView(row);
    await this.audit(tx, actor, tenantId, 'catalog_rate_card_set', 'rate_card', view.id, null, view);
    return row;
  }

  // ------------------------------------------------------------------- helpers

  /** Every product id filed in a category, archived included. */
  private async productIdsIn(db: Prisma.TransactionClient, categoryId: string): Promise<string[]> {
    const links = await db.productCategoryLink.findMany({ where: { categoryId }, select: { productId: true } });
    return links.map((l) => l.productId);
  }

  /** The categories each product sits in, by the product's own order. */
  private async categoryIdsOf(db: Prisma.TransactionClient, productIds: string[]): Promise<Map<string, string[]>> {
    const byProduct = new Map<string, string[]>(productIds.map((id) => [id, []]));
    if (productIds.length === 0) return byProduct;
    const links = await db.productCategoryLink.findMany({ where: { productId: { in: productIds } }, orderBy: { position: 'asc' } });
    for (const l of [...links].sort((a, b) => a.position - b.position)) byProduct.get(l.productId)?.push(l.categoryId);
    return byProduct;
  }

  /**
   * Categories a product of `tenantId` may be filed in: each the platform's or
   * that tenant's, and not archived — an archived category holds only what was
   * sold, nothing new (F-026-l). Any other is *not found*.
   */
  private async usableCategories(db: Prisma.TransactionClient, ids: string[], tenantId: string): Promise<void> {
    const pid = await this.platformId();
    for (const id of ids) {
      const c = (await db.productCategory.findUnique({ where: { id } })) as unknown as Row | null;
      if (!c || c['archivedAt'] || (c['tenantId'] !== pid && c['tenantId'] !== tenantId)) throw new CatalogAdminRefused('category_not_found', id);
    }
  }

  /** Replaces the categories a product sits in, in the order given. Each link carries the product's tenant (trigger). */
  private async fileIn(db: Prisma.TransactionClient, productId: string, tenantId: string, categoryIds: string[]): Promise<void> {
    await db.productCategoryLink.deleteMany({ where: { productId } });
    for (const [position, categoryId] of categoryIds.entries()) {
      await db.productCategoryLink.create({ data: { productId, categoryId, tenantId, position } });
    }
  }

  /**
   * Whether category `id` (null for a new one) may sit under `parentId`: the
   * parent is the platform's or the same tenant's and not archived (else
   * `category_not_found`), is not `id` or anything below it
   * (`category_cycle`), and the result is at most `CATEGORY_MAX_DEPTH` levels
   * deep counting `id`'s own subtree (`category_too_deep`). The database
   * refuses a cycle and a cross-tenant parent too; this is the answer the
   * caller can read.
   */
  private async placeUnder(db: Prisma.TransactionClient, id: string | null, tenantId: string, parentId: string | null | undefined): Promise<void> {
    if (!parentId) return;
    const pid = await this.platformId();
    const find = async (cid: string) => (await db.productCategory.findUnique({ where: { id: cid } })) as unknown as Row | null;
    const parent = await find(parentId);
    if (!parent || parent['archivedAt'] || (parent['tenantId'] !== pid && parent['tenantId'] !== tenantId)) {
      throw new CatalogAdminRefused('category_not_found', parentId);
    }
    let above = 0;
    for (let c: Row | null = parent; c; c = c['parentId'] ? await find(c['parentId'] as string) : null) {
      if (c['id'] === id) throw new CatalogAdminRefused('category_cycle', parentId);
      if (++above > CATEGORY_MAX_DEPTH) break;
    }
    const own = id ? await this.subtreeLevels(db, id) : 1;
    if (above + own > CATEGORY_MAX_DEPTH) throw new CatalogAdminRefused('category_too_deep', `${above + own} > ${CATEGORY_MAX_DEPTH}`);
  }

  /** How many levels a category and everything under it span: 1 for one with no children. */
  private async subtreeLevels(db: Prisma.TransactionClient, id: string): Promise<number> {
    let levels = 0;
    for (let level = [id]; level.length > 0 && levels <= CATEGORY_MAX_DEPTH; levels++) {
      level = (await db.productCategory.findMany({ where: { parentId: { in: level } }, select: { id: true } })).map((r) => r.id);
    }
    return levels;
  }

  /** A re-parent the database refused as a cycle — a concurrent one got there first — as its refusal. */
  private async refuseCycle<T>(id: string, write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (e) {
      if (isCategoryCycle(e)) throw new CatalogAdminRefused('category_cycle', id);
      throw e;
    }
  }

  /** A product's or capability's derived keys, the texts a create or patch publishes or clears, and what to draft after. */
  private itemTexts(
    kind: 'product' | 'capability',
    keyOwner: string | null,
    key: string,
    sourceLang: string,
    name: Texts | undefined,
    description: Texts | null | undefined,
  ) {
    const nameKey = catalogTextKey(keyOwner, kind, key, 'name');
    const descriptionKey = catalogTextKey(keyOwner, kind, key, 'description');
    const publish: { key: string; text: Texts }[] = [];
    const draft: DraftRequest[] = [];
    const clear: string[] = [];
    if (name) {
      publish.push({ key: nameKey, text: name });
      draft.push(...drafts(nameKey, sourceLang, name));
    }
    if (description) {
      publish.push({ key: descriptionKey, text: description });
      draft.push(...drafts(descriptionKey, sourceLang, description));
    } else if (description === null) {
      clear.push(descriptionKey);
    }
    return { nameKey, descriptionKey, publish, draft, clear };
  }

  /**
   * The source language a write settles on: the one asked for, else
   * `DEFAULT_LANGUAGE`. It and every language written must be one locale-service
   * has (`lang_unknown`), and each text given must include it
   * (`source_text_missing`) — a draft is translated from it.
   */
  private sourceLang(requested: string | undefined, name: Texts | undefined, description: Texts | null | undefined): string {
    const lang = requested ?? this.texts.defaultLanguage();
    const known = new Set(this.texts.languages());
    const written = [...Object.keys(name ?? {}), ...Object.keys(description ?? {})];
    for (const l of [lang, ...written]) if (!known.has(l)) throw new CatalogAdminRefused('lang_unknown', l);
    for (const text of [name, description]) {
      if (text && !text[lang]?.trim()) throw new CatalogAdminRefused('source_text_missing', lang);
    }
    return lang;
  }

  /**
   * Every text key the caller may review, with its item's source language: the
   * platform owner's all, any other tenant's its own items only.
   */
  private async textSourcesOf(actor: CatalogActor): Promise<Map<string, string>> {
    const { owner } = await this.access(actor);
    const where = owner ? {} : { tenantId: actor.tenantId };
    const fallback = this.texts.defaultLanguage();
    const sources = new Map<string, string>();
    const [categories, products, capabilities] = await this.within(owner, async (db) => [
      await db.productCategory.findMany({ where }),
      await db.product.findMany({ where }),
      await db.productCapability.findMany({ where }),
    ]);
    // The row's own keys: a platform row its staff made before ADR-0142 carries the `t_<id>` form.
    const described = async (r: Row, kind: 'product' | 'capability') =>
      (r['descriptionKey'] as string | null) ?? catalogTextKey(await this.keyOwner(r['tenantId'] as string), kind, r['key'] as string, 'description');
    for (const r of categories as unknown as Row[]) sources.set(r['nameKey'] as string, sourceOf(r, fallback));
    for (const r of products as unknown as Row[]) {
      sources.set(r['nameKey'] as string, sourceOf(r, fallback));
      sources.set(await described(r, 'product'), sourceOf(r, fallback));
    }
    for (const r of capabilities as unknown as Row[]) {
      sources.set(r['nameKey'] as string, sourceOf(r, fallback));
      sources.set(await described(r, 'capability'), sourceOf(r, fallback));
    }
    return sources;
  }

  /**
   * A review write: every key must be the text of an item the caller manages
   * (else that item's *not found*), each item gets an audit row, and the
   * locale-service write runs last inside the transaction.
   */
  private async publishingTexts(
    actor: CatalogActor,
    lang: string,
    keys: string[],
    change: Record<string, unknown>,
    write: () => Promise<number>,
  ): Promise<{ published: number }> {
    const { owner } = await this.access(actor);
    return this.within(owner, async (tx) => {
      const items = new Map<string, { kind: CatalogTextKind; row: Row }>();
      for (const key of keys) {
        const parsed = parseCatalogTextKey(key);
        if (!parsed) throw new CatalogAdminRefused('text_key_invalid', key);
        const missing = TEXT_ITEMS[parsed.kind].missing;
        const delegate = tx[TEXT_ITEMS[parsed.kind].model] as unknown as {
          findFirst(args: { where: Row }): Promise<Row | null>;
        };
        // An unprefixed key is the platform's (ADR-0142).
        const row = await delegate.findFirst({ where: { tenantId: parsed.tenantId ?? (await this.platformId()), key: parsed.key } });
        if (!row || (!owner && row['tenantId'] !== actor.tenantId)) throw new CatalogAdminRefused(missing, key);
        items.set(row['id'] as string, { kind: parsed.kind, row });
      }
      for (const [id, { kind, row }] of items) {
        const tenantId = row['tenantId'] as string;
        const texts = { lang, ...change };
        await this.audit(tx, actor, tenantId, TEXT_ITEMS[kind].action, TEXT_ITEMS[kind].target, id, null, { texts });
      }
      return { published: await write() };
    });
  }

  /** A row the caller may manage, or the table's own *not found* — another tenant's and the platform's alike. */
  private async managed(
    db: Prisma.TransactionClient,
    model: 'productCategory' | 'product' | 'productCapability' | 'productVariant' | 'price' | 'rateCard' | 'priceCampaign' | 'season',
    missing: CatalogAdminRejection,
    actor: CatalogActor,
    id: string,
    owner: boolean,
  ): Promise<Row> {
    const delegate = db[model] as unknown as { findUnique(args: { where: { id: string } }): Promise<Row | null> };
    const row = await delegate.findUnique({ where: { id } });
    if (!row || (!owner && row['tenantId'] !== actor.tenantId)) throw new CatalogAdminRefused(missing, id);
    return row;
  }

  /** A prepaid network variant states its traffic (F-111-p); `0` = unlimited is a statement, absent is not. */
  private refuseUnstatedTraffic(kind: FulfilmentKind | null, mode: VariantBillingMode, quotas: unknown, sku: string): void {
    if (kind && mustStateTraffic(kind, mode) && trafficQuotaOf(quotas).kind === 'missing') {
      throw new CatalogAdminRefused('traffic_quota_required', sku);
    }
  }

  /** `effectiveFrom` as given, or now; a backdated one would reprice an issued invoice. */
  private effectiveFrom(requested: string | undefined): Date {
    if (requested === undefined) return new Date();
    const at = new Date(requested);
    if (at.getTime() < Date.now() - PAST_SKEW_MS) throw new CatalogAdminRefused('price_in_the_past', requested);
    return at;
  }

  /** A unique violation as its refusal. Postgres aborts the transaction, so nothing else is tried after it. */
  private async refuseDuplicate<T>(reason: 'key_taken' | 'sku_taken', value: string, create: () => Promise<T>): Promise<T> {
    try {
      return await create();
    } catch (e) {
      if (isUniqueViolation(e) || isCapabilityKeyTaken(e)) throw new CatalogAdminRefused(reason, value);
      throw e;
    }
  }

  private async audit(
    tx: Prisma.TransactionClient,
    actor: CatalogActor,
    tenantId: string | null,
    action: Prisma.AdminAuditLogUncheckedCreateInput['action'],
    targetEntityType: Prisma.AdminAuditLogUncheckedCreateInput['targetEntityType'],
    targetEntityId: string,
    oldValue: unknown,
    newValue: unknown,
  ): Promise<void> {
    await tx.adminAuditLog.create({
      data: {
        tenantId: tenantId ?? actor.tenantId,
        adminId: actor.adminId,
        action,
        targetEntityType,
        targetEntityId,
        oldValue: oldValue === null ? Prisma.DbNull : (JSON.parse(JSON.stringify(oldValue)) as Prisma.InputJsonValue),
        newValue: JSON.parse(JSON.stringify(newValue)) as Prisma.InputJsonValue,
        adminIpAddress: actor.ip,
      },
    });
    this.logger.log(`${action} ${targetEntityId} by ${actor.adminId}`);
  }
}
