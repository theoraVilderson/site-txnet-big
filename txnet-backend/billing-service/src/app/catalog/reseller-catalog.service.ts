import { Injectable } from '@nestjs/common';
import {
  ResellerAccess,
  ResellerAccessRefused,
  ResellerAccessRejection,
  ResellerActor,
  TenantCapabilityName,
} from '@txnet-backend/shared-core';

import {
  CatalogActor,
  CatalogAdminRefused,
  CatalogAdminRejection,
  CatalogAdminService,
  CategoryRemovalOutcome,
  ListCategoriesFilter,
  CapabilityView,
  CategoryView,
  CreateCapabilityInput,
  CreateCategoryInput,
  CreateProductInput,
  CreateVariantInput,
  EditTextsInput,
  ListProductsFilter,
  PanelGroupOption,
  PriceView,
  ProductView,
  RemovalOutcome,
  PublishTextsInput,
  SetPriceInput,
  UpdateCapabilityInput,
  UpdateCategoryInput,
  UpdateProductInput,
  UpdateVariantInput,
  VariantView,
} from './catalog-admin.service';
import type { ReviewItem } from './catalog-texts';

/** The caller, as `forward-auth` proved them, plus the address a write is audited from. */
export type ResellerCatalogActor = ResellerActor & { ip: string };

/** Both doors' refusals: who may configure this reseller, and what may be done to its catalog. */
export type ResellerCatalogRejection = ResellerAccessRejection | CatalogAdminRejection;

/** A refusal, carrying the reason of whichever door closed. */
export class ResellerCatalogRefused extends Error {
  constructor(
    readonly reason: ResellerCatalogRejection,
    detail?: string,
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'ResellerCatalogRefused';
  }
}

/** A create body on this surface: `tenantId` is the path's, so it is not a key a client may send. */
export type ResellerCreateCategoryInput = Omit<CreateCategoryInput, 'tenantId'>;
export type ResellerCreateProductInput = Omit<CreateProductInput, 'tenantId'>;
export type ResellerCreateCapabilityInput = Omit<CreateCapabilityInput, 'tenantId'>;
/** A list on this surface: the tenant is the path's, so only the category narrows it. */
export type ResellerProductFilter = Omit<ListProductsFilter, 'tenantId'>;

/**
 * Catalog management for the reseller a route **names** (F-066-w7, ADR-0064):
 * `/api/catalog/tenants/:tenantId/...`. The ambient `/api/catalog` is untouched
 * and stays what a tenant managing its own catalog uses.
 *
 * **It adds a door and a scope, and no rules.** {@link ResellerAccess} (tenant
 * invariant 21) says whether this caller may configure that reseller — its
 * owner, one of its staff seats holding `tenant.manage`, or the platform
 * owner's staff — and `run` opens the reseller's tenant scope around the work.
 * Inside it, {@link CatalogAdminService} is called with the **reseller** as the
 * actor's tenant, so every rule of the ambient surface applies here by
 * construction rather than by being restated: the caller's own rows only, the
 * app pool inside a `tenantTransaction` where RLS stands behind the checks,
 * names published to locale-service inside the write's transaction with the
 * rest drafted after it, a price as history (F-0602), nothing deleted, and one
 * `admin_audit_log` row per write — in the **reseller's** tenant, naming the
 * caller as its admin.
 *
 * **Nothing here is elevated.** The actor handed on is a reseller, never the
 * platform owner, so `CatalogAdminService.access` answers `owner: false` for
 * everyone on this surface, platform staff included: the reads run on the app
 * pool, a platform item is `*_not_found`, and writing one is
 * `not_platform_owner`. Managing the platform's own catalog is done on the
 * ambient route, as the platform owner.
 *
 * **The tenant is the path's.** The reseller's owner is a user of the platform
 * owner's tenant (ADR-0059), so neither the session's `X-Tenant-Id` nor a
 * body's `tenantId` may choose it: a create is given the admitted reseller's
 * id, whatever the body held, and a product list is narrowed by category
 * alone.
 *
 * Capabilities are the reseller's own status matrix: `read` for a list, so a
 * suspended reseller can still see what it sells, `staffWrite` for every
 * write, which a suspended reseller cannot do — the pair `tenant-service` uses
 * for a reseller's domains and branding, and `ResellerGatewayService` for its
 * gateways.
 */
@Injectable()
export class ResellerCatalogService {
  constructor(
    private readonly access: ResellerAccess,
    private readonly catalog: CatalogAdminService,
  ) {}

  // -------------------------------------------------------------- panel groups

  listPanelGroups(actor: ResellerCatalogActor, tenantId: string): Promise<PanelGroupOption[]> {
    return this.run(actor, tenantId, 'read', (as) => this.catalog.listPanelGroups(as));
  }

  // ---------------------------------------------------------------- categories

  listCategories(actor: ResellerCatalogActor, tenantId: string, filter: ListCategoriesFilter = {}): Promise<CategoryView[]> {
    return this.run(actor, tenantId, 'read', (as) => this.catalog.listCategories(as, filter.archived ? { archived: true } : {}));
  }

  createCategory(actor: ResellerCatalogActor, tenantId: string, input: ResellerCreateCategoryInput): Promise<CategoryView> {
    return this.run(actor, tenantId, 'staffWrite', (as) => this.catalog.createCategory(as, { ...input, tenantId: as.tenantId }));
  }

  updateCategory(actor: ResellerCatalogActor, tenantId: string, id: string, patch: UpdateCategoryInput): Promise<CategoryView> {
    return this.run(actor, tenantId, 'staffWrite', (as) => this.catalog.updateCategory(as, id, patch));
  }

  removeCategories(actor: ResellerCatalogActor, tenantId: string, ids: string[], withProducts = false): Promise<CategoryRemovalOutcome[]> {
    return this.run(actor, tenantId, 'staffWrite', (as) => this.catalog.removeCategories(as, ids, withProducts));
  }

  // -------------------------------------------------------------- capabilities

  /** F-114-f-a: the platform's and this reseller's own. */
  listCapabilities(actor: ResellerCatalogActor, tenantId: string): Promise<CapabilityView[]> {
    return this.run(actor, tenantId, 'read', (as) => this.catalog.listCapabilities(as));
  }

  createCapability(actor: ResellerCatalogActor, tenantId: string, input: ResellerCreateCapabilityInput): Promise<CapabilityView> {
    return this.run(actor, tenantId, 'staffWrite', (as) => this.catalog.createCapability(as, { ...input, tenantId: as.tenantId }));
  }

  updateCapability(actor: ResellerCatalogActor, tenantId: string, id: string, patch: UpdateCapabilityInput): Promise<CapabilityView> {
    return this.run(actor, tenantId, 'staffWrite', (as) => this.catalog.updateCapability(as, id, patch));
  }

  removeCapability(actor: ResellerCatalogActor, tenantId: string, id: string): Promise<{ id: string; outcome: 'deleted' }> {
    return this.run(actor, tenantId, 'staffWrite', (as) => this.catalog.removeCapability(as, id));
  }

  // ------------------------------------------------------------------ products

  listProducts(actor: ResellerCatalogActor, tenantId: string, filter: ResellerProductFilter): Promise<ProductView[]> {
    // The tenant is settled by the path; only the category narrows the answer.
    return this.run(actor, tenantId, 'read', (as) =>
      this.catalog.listProducts(as, { ...(filter.categoryId ? { categoryId: filter.categoryId } : {}), ...(filter.archived ? { archived: true } : {}) }),
    );
  }

  getProduct(actor: ResellerCatalogActor, tenantId: string, id: string): Promise<ProductView & { variants: VariantView[] }> {
    return this.run(actor, tenantId, 'read', (as) => this.catalog.getProduct(as, id));
  }

  createProduct(actor: ResellerCatalogActor, tenantId: string, input: ResellerCreateProductInput): Promise<ProductView> {
    return this.run(actor, tenantId, 'staffWrite', (as) => this.catalog.createProduct(as, { ...input, tenantId: as.tenantId }));
  }

  updateProduct(actor: ResellerCatalogActor, tenantId: string, id: string, patch: UpdateProductInput): Promise<ProductView> {
    return this.run(actor, tenantId, 'staffWrite', (as) => this.catalog.updateProduct(as, id, patch));
  }

  removeProducts(actor: ResellerCatalogActor, tenantId: string, ids: string[]): Promise<RemovalOutcome[]> {
    return this.run(actor, tenantId, 'staffWrite', (as) => this.catalog.removeProducts(as, ids));
  }

  // ------------------------------------------------------------ variants, prices

  createVariant(actor: ResellerCatalogActor, tenantId: string, productId: string, input: CreateVariantInput): Promise<VariantView> {
    return this.run(actor, tenantId, 'staffWrite', (as) => this.catalog.createVariant(as, productId, input));
  }

  updateVariant(actor: ResellerCatalogActor, tenantId: string, id: string, patch: UpdateVariantInput): Promise<VariantView> {
    return this.run(actor, tenantId, 'staffWrite', (as) => this.catalog.updateVariant(as, id, patch));
  }

  setPrice(actor: ResellerCatalogActor, tenantId: string, variantId: string, input: SetPriceInput): Promise<PriceView> {
    return this.run(actor, tenantId, 'staffWrite', (as) => this.catalog.setPrice(as, variantId, input));
  }

  deactivatePrice(actor: ResellerCatalogActor, tenantId: string, priceId: string): Promise<PriceView> {
    return this.run(actor, tenantId, 'staffWrite', (as) => this.catalog.deactivatePrice(as, priceId));
  }

  // ------------------------------------------------------------ translations

  listTextDrafts(actor: ResellerCatalogActor, tenantId: string, lang?: string): Promise<ReviewItem[]> {
    return this.run(actor, tenantId, 'read', (as) => this.catalog.listTextDrafts(as, lang));
  }

  draftMissingTexts(actor: ResellerCatalogActor, tenantId: string): Promise<{ drafted: number }> {
    return this.run(actor, tenantId, 'staffWrite', (as) => this.catalog.draftMissingTexts(as));
  }

  publishTextDrafts(actor: ResellerCatalogActor, tenantId: string, input: PublishTextsInput): Promise<{ published: number }> {
    return this.run(actor, tenantId, 'staffWrite', (as) => this.catalog.publishTextDrafts(as, input));
  }

  editTexts(actor: ResellerCatalogActor, tenantId: string, input: EditTextsInput): Promise<{ published: number }> {
    return this.run(actor, tenantId, 'staffWrite', (as) => this.catalog.editTexts(as, input));
  }

  /**
   * Admit, open the reseller's scope, then work — `ResellerAccess.run`, with
   * both doors' refusals turned into this surface's one type so the controller
   * has a single map from reason to status.
   *
   * The work `await`s inside itself, as `runWithTenant` requires: a Prisma
   * promise returned unawaited would run after the scope has closed.
   */
  private async run<T>(
    actor: ResellerCatalogActor,
    tenantId: string,
    capability: TenantCapabilityName,
    work: (as: CatalogActor) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.access.run(actor, tenantId, capability, (reseller) =>
        work({ adminId: actor.userId, tenantId: reseller.id, ip: actor.ip }),
      );
    } catch (e) {
      if (e instanceof ResellerAccessRefused) throw new ResellerCatalogRefused(e.reason, tenantId);
      if (e instanceof CatalogAdminRefused) throw new ResellerCatalogRefused(e.reason, e.message);
      throw e;
    }
  }
}
