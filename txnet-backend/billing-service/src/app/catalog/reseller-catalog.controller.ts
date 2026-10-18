import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Patch,
  Put,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';
import { RateLimit } from '../request/rate-limit';
import { ZodValidationPipe } from '@txnet-backend/shared-core';
import { CATALOG_REFUSAL_STATUS, catalogRefusal, type CatalogRefusalStatus } from './catalog-refusal';
import { CATALOG_ADMIN_READ as READ, CATALOG_ADMIN_WRITE as WRITE } from './catalog-admin.rate-limit';
import {
  CreateResellerCapabilityBody,
  CreateResellerCategoryBody,
  CreateResellerProductBody,
  CreateVariantBody,
  EditTextsBody,
  ListResellerProductsQuery,
  ListTextDraftsQuery,
  PublishTextsBody,
  RemoveCategoriesBody,
  ListCategoriesQuery,
  RemoveProductsBody,
  SetPriceBody,
  CreateSeasonBody,
  UpdateSeasonBody,
  SeasonPriceBody,
  CreateCampaignBody,
  SetRateCardBody,
  UpdateCapabilityBody,
  UpdateCategoryBody,
  UpdateProductBody,
  ProductAudienceBody,
  productAudienceSchema,
  UpdateVariantBody,
  createResellerCapabilitySchema,
  createResellerCategorySchema,
  createResellerProductSchema,
  createVariantSchema,
  editTextsSchema,
  listResellerProductsSchema,
  listTextDraftsSchema,
  publishTextsSchema,
  removeCategoriesSchema,
  listCategoriesSchema,
  removeProductsSchema,
  setPriceSchema,
  createSeasonSchema,
  updateSeasonSchema,
  seasonPriceSchema,
  createCampaignSchema,
  setRateCardSchema,
  updateCapabilitySchema,
  updateCategorySchema,
  updateProductSchema,
  updateVariantSchema,
} from './catalog-admin.schema';
import {
  CreateVariantInput,
  EditTextsInput,
  PublishTextsInput,
  SetPriceInput,
  SeasonInput,
  CreateCampaignInput,
  SetRateCardInput,
  UpdateCapabilityInput,
  UpdateCategoryInput,
  UpdateProductInput,
} from './catalog-admin.service';
import {
  ResellerCatalogActor,
  ResellerCatalogRefused,
  ResellerCatalogRejection,
  ResellerCatalogService,
  ResellerCreateCapabilityInput,
  ResellerCreateCategoryInput,
  ResellerCreateProductInput,
} from './reseller-catalog.service';

/** Every refusal of either door gets a status; a new reason does not compile until it gets one. */
export const STATUS: Record<ResellerCatalogRejection, CatalogRefusalStatus> = {
  // ResellerAccess (invariant 21): who may configure this reseller.
  not_allowed: 403,
  reseller_not_found: 404,
  reseller_suspended: 403,
  reseller_terminated: 409,
  // CatalogAdminService: what may be done to the catalog. The ambient
  // surface's statuses, so one client reads both.
  ...CATALOG_REFUSAL_STATUS,
};

/**
 * A named reseller's catalog (F-066-w7, ADR-0064):
 * `/api/catalog/tenants/:tenantId/...`, shaped exactly like `/api/catalog` so
 * the panel's catalog components serve both (F-066-w8). The ambient surface is
 * untouched and stays what a tenant managing its **own** catalog uses.
 *
 * **No `CatalogPermissionGuard`**, as on the reseller's gateway and bot routes:
 * a reseller's owner holds no `catalog.manage` — they are a customer of the
 * platform, not one of its operators — and `ResellerAccess` is the door
 * instead. It admits the reseller's owner, one of its staff seats holding
 * `catalog.manage` (AC-1-e), and the platform owner's staff. What may then be done is
 * `CatalogAdminService`'s, unchanged: the work runs as the reseller, so a
 * platform category is `category_not_found` here and a platform item cannot be
 * written at all — that is done on the ambient route, as the platform owner.
 *
 * The routes are the ambient ones under the reseller's prefix, and `tenantId`
 * is gone from every body and query: the path already said whose catalog this
 * is, and `.strict()` refuses a second answer rather than ignoring it.
 */
@Controller('catalog/tenants/:tenantId')
export class ResellerCatalogController {
  constructor(private readonly catalog: ResellerCatalogService) {}

  /** F-026-p: the groups this reseller's variants may name — the platform's and its own. */
  @Get('panel-groups')
  @RateLimit(READ)
  async listPanelGroups(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.catalog.listPanelGroups(this.actor(req, ip), tenantId));
  }

  /** F-116-h10a: the currency this reseller's new prices are written in — its operating currency. */
  @Get('pricing-currency')
  @RateLimit(READ)
  async pricingCurrency(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.catalog.pricingCurrency(this.actor(req, ip), tenantId));
  }

  @Get('categories')
  @RateLimit(READ)
  async listCategories(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Query(new ZodValidationPipe(listCategoriesSchema)) query: ListCategoriesQuery,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return this.refusing(() => this.catalog.listCategories(this.actor(req, ip), tenantId, query));
  }

  @Post('categories')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE)
  async createCategory(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body(new ZodValidationPipe(createResellerCategorySchema)) body: CreateResellerCategoryBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    // The casts are for this project's non-strict tsconfig, under which zod infers every key as optional.
    return this.refusing(() => this.catalog.createCategory(this.actor(req, ip), tenantId, body as ResellerCreateCategoryInput));
  }

  @Patch('categories/:id')
  @RateLimit(WRITE)
  async updateCategory(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateCategorySchema)) body: UpdateCategoryBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return this.refusing(() => this.catalog.updateCategory(this.actor(req, ip), tenantId, id, body as UpdateCategoryInput));
  }

  /** F-026-j: one outcome per id — `deleted`, `has_products`, or `not_found`. */
  @Post('categories/remove')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE)
  async removeCategories(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body(new ZodValidationPipe(removeCategoriesSchema)) body: RemoveCategoriesBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return this.refusing(() => this.catalog.removeCategories(this.actor(req, ip), tenantId, body.ids as string[], body.withProducts === true));
  }

  /** F-114-f-a: the capabilities this reseller's products may carry — the platform's and its own. */
  @Get('capabilities')
  @RateLimit(READ)
  async listCapabilities(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.catalog.listCapabilities(this.actor(req, ip), tenantId));
  }

  @Post('capabilities')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE)
  async createCapability(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body(new ZodValidationPipe(createResellerCapabilitySchema)) body: CreateResellerCapabilityBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return this.refusing(() => this.catalog.createCapability(this.actor(req, ip), tenantId, body as ResellerCreateCapabilityInput));
  }

  @Patch('capabilities/:id')
  @RateLimit(WRITE)
  async updateCapability(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateCapabilitySchema)) body: UpdateCapabilityBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return this.refusing(() => this.catalog.updateCapability(this.actor(req, ip), tenantId, id, body as UpdateCapabilityInput));
  }

  @Post('capabilities/:id/remove')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE)
  async removeCapability(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return this.refusing(() => this.catalog.removeCapability(this.actor(req, ip), tenantId, id));
  }

  @Get('products')
  @RateLimit(READ)
  async listProducts(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Query(new ZodValidationPipe(listResellerProductsSchema)) query: ListResellerProductsQuery,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return this.refusing(() => this.catalog.listProducts(this.actor(req, ip), tenantId, query));
  }

  @Post('products')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE)
  async createProduct(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body(new ZodValidationPipe(createResellerProductSchema)) body: CreateResellerProductBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return this.refusing(() => this.catalog.createProduct(this.actor(req, ip), tenantId, body as ResellerCreateProductInput));
  }

  /** F-026-h: one outcome per id — `deleted`, `archived`, or `not_found`. */
  @Post('products/remove')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE)
  async removeProducts(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body(new ZodValidationPipe(removeProductsSchema)) body: RemoveProductsBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return this.refusing(() => this.catalog.removeProducts(this.actor(req, ip), tenantId, body.ids as string[]));
  }

  @Get('products/:id')
  @RateLimit(READ)
  async getProduct(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return this.refusing(() => this.catalog.getProduct(this.actor(req, ip), tenantId, id));
  }

  @Patch('products/:id')
  @RateLimit(WRITE)
  async updateProduct(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateProductSchema)) body: UpdateProductBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return this.refusing(() => this.catalog.updateProduct(this.actor(req, ip), tenantId, id, body as UpdateProductInput));
  }

  @Put('products/:id/audience')
  @RateLimit(WRITE)
  async setProductAudience(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(productAudienceSchema)) body: ProductAudienceBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return this.refusing(() => this.catalog.setProductAudience(this.actor(req, ip), tenantId, id, body.userGroupIds as string[]));
  }

  @Post('products/:id/variants')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE)
  async createVariant(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(createVariantSchema)) body: CreateVariantBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return this.refusing(() => this.catalog.createVariant(this.actor(req, ip), tenantId, id, body as CreateVariantInput));
  }

  @Patch('variants/:id')
  @RateLimit(WRITE)
  async updateVariant(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateVariantSchema)) body: UpdateVariantBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return this.refusing(() => this.catalog.updateVariant(this.actor(req, ip), tenantId, id, body));
  }

  @Post('variants/:id/prices')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE)
  async setPrice(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(setPriceSchema)) body: SetPriceBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return this.refusing(() => this.catalog.setPrice(this.actor(req, ip), tenantId, id, body as SetPriceInput));
  }

  @Post('prices/:id/deactivate')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE)
  async deactivatePrice(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return this.refusing(() => this.catalog.deactivatePrice(this.actor(req, ip), tenantId, id));
  }

  // ------------------------------------------------------- campaigns (F-503-a)

  @Post('variants/:id/campaigns')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE)
  async createCampaign(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(createCampaignSchema)) body: CreateCampaignBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return this.refusing(() => this.catalog.createCampaign(this.actor(req, ip), tenantId, id, body as CreateCampaignInput));
  }

  @Get('variants/:id/campaigns')
  @RateLimit(READ)
  async listCampaigns(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.catalog.listCampaigns(this.actor(req, ip), tenantId, id));
  }

  @Post('campaigns/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE)
  async cancelCampaign(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.catalog.cancelCampaign(this.actor(req, ip), tenantId, id));
  }

  // ---------------------------------------------------------- seasons (F-505-a)

  @Get('seasons')
  @RateLimit(READ)
  async listSeasons(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.catalog.listSeasons(this.actor(req, ip), tenantId));
  }

  @Post('seasons')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE)
  async createSeason(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Body(new ZodValidationPipe(createSeasonSchema)) body: CreateSeasonBody, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.catalog.createSeason(this.actor(req, ip), tenantId, body as SeasonInput));
  }

  @Patch('seasons/:id')
  @RateLimit(WRITE)
  async updateSeason(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodValidationPipe(updateSeasonSchema)) body: UpdateSeasonBody, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.catalog.updateSeason(this.actor(req, ip), tenantId, id, body));
  }

  @Put('seasons/:id/prices/:variantId')
  @RateLimit(WRITE)
  async setSeasonPrice(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('variantId', new ParseUUIDPipe()) variantId: string,
    @Body(new ZodValidationPipe(seasonPriceSchema)) body: SeasonPriceBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return this.refusing(() => this.catalog.setSeasonPrice(this.actor(req, ip), tenantId, id, variantId, body.amount));
  }

  @Post('seasons/:id/prices/:variantId/remove')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE)
  async removeSeasonPrice(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Param('id', new ParseUUIDPipe()) id: string, @Param('variantId', new ParseUUIDPipe()) variantId: string, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.catalog.removeSeasonPrice(this.actor(req, ip), tenantId, id, variantId));
  }

  @Post('variants/:id/rate-cards')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE)
  async setRateCard(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(setRateCardSchema)) body: SetRateCardBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return this.refusing(() => this.catalog.setRateCard(this.actor(req, ip), tenantId, id, body as SetRateCardInput));
  }

  @Post('rate-cards/:id/deactivate')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE)
  async deactivateRateCard(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return this.refusing(() => this.catalog.deactivateRateCard(this.actor(req, ip), tenantId, id));
  }

  // ---------------------------------------------------- translations (F-1533-d)

  @Get('translations')
  @RateLimit(READ)
  async listTextDrafts(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Query(new ZodValidationPipe(listTextDraftsSchema)) query: ListTextDraftsQuery,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return this.refusing(() => this.catalog.listTextDrafts(this.actor(req, ip), tenantId, query.lang));
  }

  @Post('translations/draft-missing')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE)
  async draftMissingTexts(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.catalog.draftMissingTexts(this.actor(req, ip), tenantId));
  }

  @Post('translations/publish')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE)
  async publishTextDrafts(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body(new ZodValidationPipe(publishTextsSchema)) body: PublishTextsBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return this.refusing(() => this.catalog.publishTextDrafts(this.actor(req, ip), tenantId, body as PublishTextsInput));
  }

  @Patch('translations')
  @RateLimit(WRITE)
  async editTexts(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body(new ZodValidationPipe(editTextsSchema)) body: EditTextsBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return this.refusing(() => this.catalog.editTexts(this.actor(req, ip), tenantId, body as EditTextsInput));
  }

  /** Who is asking, as the gate proved them. The reseller they are asking about is the path's. */
  private actor(req: Request, ip: string): ResellerCatalogActor {
    const { userId, tenantId, permissions } = identityOf(req);
    return { userId, tenantId, permissions, ip };
  }

  /** One place that turns a refusal into a status — the ambient controller's, over both doors' reasons. */
  private async refusing<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      if (!(e instanceof ResellerCatalogRefused)) throw e;
      throw catalogRefusal(STATUS[e.reason], e.reason, e.message);
    }
  }
}
