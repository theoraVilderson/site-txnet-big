import { Injectable, Logger } from '@nestjs/common';
import { FulfilmentKind, Prisma, QualityTier, TenantType, VariantBillingMode, VariantVisibility } from '@prisma/client';

import { tenantTransaction } from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogTextKind, CatalogTextService, ReviewItem, Texts, catalogTextKey, parseCatalogTextKey } from './catalog-texts';

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
 * rolls the row back; every other language is drafted from the source after it
 * commits and never fails it.
 */

export type CatalogActor = { adminId: string; tenantId: string; ip: string };

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
  | 'source_text_missing';

export class CatalogAdminRefused extends Error {
  constructor(
    readonly reason: CatalogAdminRejection,
    detail = '',
  ) {
    super(`catalog refused: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'CatalogAdminRefused';
  }
}

export type CreateCategoryInput = { tenantId?: string | null; key: string; sourceLang?: string; name: Texts };
/** A new `sourceLang` needs `name` with that language's text. */
export type UpdateCategoryInput = { sourceLang?: string; name?: Texts; isActive?: boolean };
export type CreateProductInput = {
  tenantId?: string | null;
  categoryId: string;
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
export type UpdateProductInput = {
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
export type VariantFields = {
  nameKey?: string | null;
  quotas?: Record<string, unknown>;
  durationDays?: number | null;
  visibility?: VariantVisibility;
  panelGroupId?: string | null;
  qualityTier?: QualityTier;
};
export type CreateVariantInput = VariantFields & {
  sku: string;
  billingMode: VariantBillingMode;
  visibility: VariantVisibility;
  /** The first price, base currency (C-02). */
  price: string;
  effectiveFrom?: string;
};
export type UpdateVariantInput = VariantFields & { isActive?: boolean };
export type SetPriceInput = { amount: string; effectiveFrom?: string };
/** `archived`: the archived products alone; the list otherwise leaves them out (F-026-h). */
export type ListProductsFilter = { categoryId?: string; tenantId?: string; archived?: boolean };
/** What `removeProducts` did to one id: gone for good, kept but archived, or not the caller's to remove. */
export type RemovalOutcome = { id: string; outcome: 'deleted' | 'archived' | 'not_found' };
export type PublishTextsInput = { lang: string; keys: string[] };
export type EditTextsInput = { lang: string; texts: Record<string, string> };

export type PriceView = { id: string; variantId: string; amount: string; effectiveFrom: Date; isActive: boolean };
export type CategoryView = {
  id: string;
  tenantId: string | null;
  key: string;
  nameKey: string;
  /** The language the admin wrote it in; a reader's fallback. `DEFAULT_LANGUAGE` for a row from before F-1533-f. */
  sourceLang: string;
  isActive: boolean;
};
export type ProductView = {
  id: string;
  tenantId: string | null;
  categoryId: string;
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
export type VariantView = {
  id: string;
  tenantId: string | null;
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
};

type Row = Record<string, unknown>;

/** Clock skew tolerated between the admin's "now" and ours before a price counts as backdated. */
const PAST_SKEW_MS = 60_000;

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
/**
 * A delete some foreign key still points at: a Grant, a coupon, a coupon scope —
 * or whatever references a variant next. `ON DELETE RESTRICT` is Postgres
 * `23001`, which Prisma does not map and throws as an unknown error; a
 * `NO ACTION` key is `23503`, mapped to `P2003`.
 */
const isStillReferenced = (e: unknown) =>
  (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003') ||
  (e instanceof Prisma.PrismaClientUnknownRequestError && /code: "(23001|23503)"/.test(e.message));

/** A row's source language, `DEFAULT_LANGUAGE` when it has none (a row from before F-1533-f). */
const sourceOf = (r: Row, defaultLang: string) => (r['sourceLang'] as string | null) ?? defaultLang;

const categoryView = (r: Row, defaultLang: string): CategoryView => ({
  id: r['id'] as string,
  tenantId: (r['tenantId'] as string | null) ?? null,
  key: r['key'] as string,
  nameKey: r['nameKey'] as string,
  sourceLang: sourceOf(r, defaultLang),
  isActive: r['isActive'] as boolean,
});

const productView = (r: Row, defaultLang: string): ProductView => ({
  id: r['id'] as string,
  tenantId: (r['tenantId'] as string | null) ?? null,
  categoryId: r['categoryId'] as string,
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

const priceView = (r: Row): PriceView => ({
  id: r['id'] as string,
  variantId: r['variantId'] as string,
  amount: new Prisma.Decimal(r['amount'] as Prisma.Decimal.Value).toFixed(2),
  effectiveFrom: r['effectiveFrom'] as Date,
  isActive: r['isActive'] as boolean,
});

const variantView = (r: Row, prices: Row[]): VariantView => ({
  id: r['id'] as string,
  tenantId: (r['tenantId'] as string | null) ?? null,
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
  prices: prices
    .map(priceView)
    .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime()),
});

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

  /** Whether the caller is the platform owner. */
  async access(actor: CatalogActor): Promise<{ owner: boolean }> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: actor.tenantId }, select: { tenantType: true } });
    return { owner: tenant?.tenantType === TenantType.platform_owner };
  }

  /** Run `fn` in one transaction on the pool that serves this caller (ADR-0053). */
  /**
   * A variant is provisioned on a platform panel group or its own tenant's
   * (F-027-bk); any other is not found, as another tenant's variant is. The
   * database refuses the same (`product_variant_panel_group_fits`) — this is
   * the refusal the caller can read.
   */
  private async usableGroup(db: Prisma.TransactionClient, id: string | null | undefined, tenantId: string | null): Promise<void> {
    if (!id) return;
    const group = await db.panelGroup.findUnique({ where: { id }, select: { tenantId: true } });
    if (!group || (group.tenantId !== null && group.tenantId !== tenantId)) throw new CatalogAdminRefused('panel_group_not_found', id);
  }

  private within<T>(owner: boolean, fn: (db: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return owner ? this.all.$transaction(fn) : tenantTransaction(this.prisma, fn);
  }

  /** Whose a new item is. Absent = the caller's tenant; `null` = the platform's; another tenant = the owner's alone. */
  async ownerOfNew(actor: CatalogActor, requested: string | null | undefined): Promise<string | null> {
    const tenantId = requested === undefined ? actor.tenantId : requested;
    if (tenantId === actor.tenantId) return tenantId;
    const { owner } = await this.access(actor);
    if (!owner) throw new CatalogAdminRefused('not_platform_owner', tenantId === null ? 'a platform item' : "another tenant's item");
    if (tenantId !== null && !(await this.all.tenant.findUnique({ where: { id: tenantId }, select: { id: true } }))) {
      throw new CatalogAdminRefused('tenant_not_found', tenantId);
    }
    return tenantId;
  }

  // ---------------------------------------------------------------- categories

  async listCategories(actor: CatalogActor): Promise<CategoryView[]> {
    const { owner } = await this.access(actor);
    // A tenant sees the platform's shared categories beside its own: it files products in either.
    const rows = await this.within(owner, (db) =>
      db.productCategory.findMany({
        where: owner ? {} : { OR: [{ tenantId: null }, { tenantId: actor.tenantId }] },
        orderBy: { key: 'asc' },
      }),
    );
    return (rows as unknown as Row[]).map((r) => categoryView(r, this.texts.defaultLanguage()));
  }

  async createCategory(actor: CatalogActor, input: CreateCategoryInput): Promise<CategoryView> {
    const { owner } = await this.access(actor);
    const tenantId = await this.ownerOfNew(actor, input.tenantId);
    const sourceLang = this.sourceLang(input.sourceLang, input.name, undefined);
    const nameKey = catalogTextKey(tenantId, 'category', input.key, 'name');
    const view = await this.within(owner, async (tx) => {
      const row = (await this.refuseDuplicate('key_taken', input.key, () =>
        tx.productCategory.create({ data: { tenantId, key: input.key, nameKey, sourceLang } }),
      )) as unknown as Row;
      const created = categoryView(row, this.texts.defaultLanguage());
      await this.audit(tx, actor, tenantId, 'catalog_category_create', 'product_category', created.id, null, { ...created, name: input.name });
      await this.texts.publishSources([{ key: nameKey, text: input.name }]);
      return created;
    });
    void this.texts.draftOthers(drafts(nameKey, sourceLang, input.name));
    return view;
  }

  async updateCategory(actor: CatalogActor, id: string, patch: UpdateCategoryInput): Promise<CategoryView> {
    const { owner } = await this.access(actor);
    const renaming = patch.name !== undefined || patch.sourceLang !== undefined;
    let sourceLang: string | null = null;
    const view = await this.within(owner, async (tx) => {
      const before = await this.managed(tx, 'productCategory', 'category_not_found', actor, id, owner);
      sourceLang = renaming ? this.sourceLang(patch.sourceLang ?? sourceOf(before, this.texts.defaultLanguage()), patch.name ?? {}, undefined) : null;
      const nameKey = catalogTextKey((before['tenantId'] as string | null) ?? null, 'category', before['key'] as string, 'name');
      const data = { ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}), ...(renaming ? { nameKey, sourceLang } : {}) };
      const row = (await tx.productCategory.update({ where: { id }, data })) as unknown as Row;
      const updated = categoryView(row, this.texts.defaultLanguage());
      await this.audit(tx, actor, updated.tenantId, 'catalog_category_update', 'product_category', id, categoryView(before, this.texts.defaultLanguage()), { ...updated, name: patch.name });
      if (patch.name) await this.texts.publishSources([{ key: nameKey, text: patch.name }]);
      return updated;
    });
    if (patch.name && sourceLang) void this.texts.draftOthers(drafts(view.nameKey, sourceLang, patch.name));
    return view;
  }

  // ------------------------------------------------------------------ products

  async listProducts(actor: CatalogActor, filter: ListProductsFilter = {}): Promise<ProductView[]> {
    const { owner } = await this.access(actor);
    const tenant = owner ? (filter.tenantId === 'platform' ? null : filter.tenantId) : actor.tenantId;
    const rows = await this.within(owner, (db) =>
      db.product.findMany({
        where: {
          ...(tenant === undefined ? {} : { tenantId: tenant }),
          ...(filter.categoryId ? { categoryId: filter.categoryId } : {}),
          archivedAt: filter.archived ? { not: null } : null,
        },
        orderBy: { key: 'asc' },
      }),
    );
    return (rows as unknown as Row[]).map((r) => productView(r, this.texts.defaultLanguage()));
  }

  /** A product with its variants and each variant's whole price history. */
  async getProduct(actor: CatalogActor, id: string): Promise<ProductView & { variants: VariantView[] }> {
    const { owner } = await this.access(actor);
    return this.within(owner, async (db) => {
      const product = await this.managed(db, 'product', 'product_not_found', actor, id, owner);
      const variants = (await db.productVariant.findMany({ where: { productId: id }, orderBy: { sku: 'asc' } })) as unknown as Row[];
      const withPrices: VariantView[] = [];
      for (const v of variants) {
        withPrices.push(variantView(v, (await db.price.findMany({ where: { variantId: v['id'] as string } })) as unknown as Row[]));
      }
      return { ...productView(product, this.texts.defaultLanguage()), variants: withPrices };
    });
  }

  async createProduct(actor: CatalogActor, input: CreateProductInput): Promise<ProductView> {
    const { owner } = await this.access(actor);
    const tenantId = await this.ownerOfNew(actor, input.tenantId);
    const sourceLang = this.sourceLang(input.sourceLang, input.name, input.description);
    const texts = this.productTexts(tenantId, input.key, sourceLang, input.name, input.description);
    const view = await this.within(owner, async (tx) => {
      const category = (await tx.productCategory.findUnique({ where: { id: input.categoryId } })) as unknown as Row | null;
      // The platform's shared category holds anyone's products; a tenant's only its own.
      if (!category || (category['tenantId'] !== null && category['tenantId'] !== tenantId)) {
        throw new CatalogAdminRefused('category_not_found', input.categoryId);
      }
      const row = (await this.refuseDuplicate('key_taken', input.key, () =>
        tx.product.create({
          data: {
            tenantId,
            categoryId: input.categoryId,
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
      const created = productView(row, this.texts.defaultLanguage());
      await this.audit(tx, actor, tenantId, 'catalog_product_create', 'product', created.id, null, {
        ...created,
        name: input.name,
        description: input.description ?? null,
      });
      await this.texts.publishSources(texts.publish);
      await this.texts.clear(texts.clear);
      return created;
    });
    void this.texts.draftOthers(texts.draft);
    return view;
  }

  /** The key and fulfilment kind stay: a key is referenced by string, and a Grant's handler by its kind. */
  async updateProduct(actor: CatalogActor, id: string, patch: UpdateProductInput): Promise<ProductView> {
    const { owner } = await this.access(actor);
    const renaming = patch.name !== undefined || patch.sourceLang !== undefined;
    let draft: DraftRequest[] = [];
    const view = await this.within(owner, async (tx) => {
      const before = await this.managed(tx, 'product', 'product_not_found', actor, id, owner);
      const current = sourceOf(before, this.texts.defaultLanguage());
      const sourceLang =
        renaming || patch.description ? this.sourceLang(patch.sourceLang ?? current, patch.name ?? (renaming ? {} : undefined), patch.description) : current;
      const texts = this.productTexts((before['tenantId'] as string | null) ?? null, before['key'] as string, sourceLang, patch.name, patch.description);
      draft = texts.draft;
      const data: Prisma.ProductUpdateInput = {
        ...(renaming ? { nameKey: texts.nameKey, sourceLang } : {}),
        ...(patch.description !== undefined ? { descriptionKey: patch.description ? texts.descriptionKey : null } : {}),
        ...(patch.featureKeys !== undefined ? { featureKeys: patch.featureKeys } : {}),
        ...(patch.defaultQuotas !== undefined ? { defaultQuotas: patch.defaultQuotas as Prisma.InputJsonValue } : {}),
        ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
        ...(patch.archived === false ? { archivedAt: null } : {}),
      };
      const updated = productView((await tx.product.update({ where: { id }, data })) as unknown as Row, this.texts.defaultLanguage());
      await this.audit(tx, actor, updated.tenantId, 'catalog_product_update', 'product', id, productView(before, this.texts.defaultLanguage()), {
        ...updated,
        name: patch.name,
        description: patch.description,
      });
      await this.texts.publishSources(texts.publish);
      await this.texts.clear(texts.clear);
      return updated;
    });
    void this.texts.draftOthers(draft);
    return view;
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
    try {
      return await this.within(owner, async (tx) => {
        const before = await this.managed(tx, 'product', 'product_not_found', actor, id, owner);
        const variants = (await tx.productVariant.findMany({ where: { productId: id } })) as unknown as Row[];
        await tx.productVariant.deleteMany({ where: { productId: id } });
        await tx.product.delete({ where: { id } });
        await this.audit(tx, actor, (before['tenantId'] as string | null) ?? null, 'catalog_product_delete', 'product', id, productView(before, this.texts.defaultLanguage()), {
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
      const updated = await tx.product.update({ where: { id }, data: { isActive: false, archivedAt: new Date() } });
      await this.audit(tx, actor, (before['tenantId'] as string | null) ?? null, 'catalog_product_archive', 'product', id, productView(before, this.texts.defaultLanguage()), {
        ...productView(updated as unknown as Row, this.texts.defaultLanguage()),
        outcome: 'archived',
      });
      return 'archived' as const;
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
    const effectiveFrom = this.effectiveFrom(input.effectiveFrom);

    return this.within(owner, async (tx) => {
      const product = await this.managed(tx, 'product', 'product_not_found', actor, productId, owner);
      const tenantId = (product['tenantId'] as string | null) ?? null;
      await this.usableGroup(tx, input.panelGroupId, tenantId);
      const variant = (await this.refuseDuplicate('sku_taken', input.sku, () =>
        tx.productVariant.create({
          data: {
            tenantId,
            productId,
            sku: input.sku,
            nameKey: input.nameKey ?? null,
            quotas: (input.quotas ?? product['defaultQuotas'] ?? {}) as Prisma.InputJsonValue,
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
          effectiveFrom,
          createdByAdminId: actor.adminId,
        },
      })) as unknown as Row;
      const view = variantView(variant, [price]);
      await this.audit(tx, actor, tenantId, 'catalog_variant_create', 'product_variant', view.id, null, view);
      return view;
    });
  }

  /** The SKU and billing mode stay: a link names the SKU, and a Grant copied the mode. */
  async updateVariant(actor: CatalogActor, id: string, patch: UpdateVariantInput): Promise<VariantView> {
    const { owner } = await this.access(actor);
    return this.within(owner, async (tx) => {
      const before = await this.managed(tx, 'productVariant', 'variant_not_found', actor, id, owner);
      await this.usableGroup(tx, patch.panelGroupId, (before['tenantId'] as string | null) ?? null);
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
      const view = variantView(row, prices);
      await this.audit(tx, actor, view.tenantId, 'catalog_variant_update', 'product_variant', id, variantView(before, []), { ...view, prices: undefined });
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
      const tenantId = (variant['tenantId'] as string | null) ?? null;
      const row = (await tx.price.create({
        data: { tenantId, variantId, amount: new Prisma.Decimal(input.amount), effectiveFrom, createdByAdminId: actor.adminId },
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
      const view = priceView((await tx.price.update({ where: { id: priceId }, data: { isActive: false } })) as unknown as Row);
      await this.audit(tx, actor, (before['tenantId'] as string | null) ?? null, 'catalog_price_deactivate', 'price', priceId, priceView(before), view);
      return view;
    });
  }

  // ------------------------------------------------------------------- helpers

  /** A product's derived keys, the texts a create or patch publishes or clears, and what to draft after. */
  private productTexts(tenantId: string | null, key: string, sourceLang: string, name: Texts | undefined, description: Texts | null | undefined) {
    const nameKey = catalogTextKey(tenantId, 'product', key, 'name');
    const descriptionKey = catalogTextKey(tenantId, 'product', key, 'description');
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
    const [categories, products] = await this.within(owner, async (db) => [await db.productCategory.findMany({ where }), await db.product.findMany({ where })]);
    for (const r of categories as unknown as Row[]) {
      sources.set(catalogTextKey((r['tenantId'] as string | null) ?? null, 'category', r['key'] as string, 'name'), sourceOf(r, fallback));
    }
    for (const r of products as unknown as Row[]) {
      const tenantId = (r['tenantId'] as string | null) ?? null;
      sources.set(catalogTextKey(tenantId, 'product', r['key'] as string, 'name'), sourceOf(r, fallback));
      sources.set(catalogTextKey(tenantId, 'product', r['key'] as string, 'description'), sourceOf(r, fallback));
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
        const missing: CatalogAdminRejection = parsed.kind === 'product' ? 'product_not_found' : 'category_not_found';
        const delegate = (parsed.kind === 'product' ? tx.product : tx.productCategory) as unknown as {
          findFirst(args: { where: Row }): Promise<Row | null>;
        };
        const row = await delegate.findFirst({ where: { tenantId: parsed.tenantId, key: parsed.key } });
        if (!row || (!owner && row['tenantId'] !== actor.tenantId)) throw new CatalogAdminRefused(missing, key);
        items.set(row['id'] as string, { kind: parsed.kind, row });
      }
      for (const [id, { kind, row }] of items) {
        const tenantId = (row['tenantId'] as string | null) ?? null;
        const texts = { lang, ...change };
        if (kind === 'product') await this.audit(tx, actor, tenantId, 'catalog_product_update', 'product', id, null, { texts });
        else await this.audit(tx, actor, tenantId, 'catalog_category_update', 'product_category', id, null, { texts });
      }
      return { published: await write() };
    });
  }

  /** A row the caller may manage, or the table's own *not found* — another tenant's and the platform's alike. */
  private async managed(
    db: Prisma.TransactionClient,
    model: 'productCategory' | 'product' | 'productVariant' | 'price',
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
      if (isUniqueViolation(e)) throw new CatalogAdminRefused(reason, value);
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
