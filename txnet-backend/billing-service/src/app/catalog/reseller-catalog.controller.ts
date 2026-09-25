import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';
import { RateLimit } from '../request/rate-limit';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { CATALOG_ADMIN_READ as READ, CATALOG_ADMIN_WRITE as WRITE } from './catalog-admin.rate-limit';
import {
  CreateResellerCategoryBody,
  CreateResellerProductBody,
  CreateVariantBody,
  EditTextsBody,
  ListResellerProductsQuery,
  ListTextDraftsQuery,
  PublishTextsBody,
  RemoveProductsBody,
  SetPriceBody,
  UpdateCategoryBody,
  UpdateProductBody,
  UpdateVariantBody,
  createResellerCategorySchema,
  createResellerProductSchema,
  createVariantSchema,
  editTextsSchema,
  listResellerProductsSchema,
  listTextDraftsSchema,
  publishTextsSchema,
  removeProductsSchema,
  setPriceSchema,
  updateCategorySchema,
  updateProductSchema,
  updateVariantSchema,
} from './catalog-admin.schema';
import {
  CreateVariantInput,
  EditTextsInput,
  PublishTextsInput,
  SetPriceInput,
  UpdateCategoryInput,
  UpdateProductInput,
} from './catalog-admin.service';
import {
  ResellerCatalogActor,
  ResellerCatalogRefused,
  ResellerCatalogRejection,
  ResellerCatalogService,
  ResellerCreateCategoryInput,
  ResellerCreateProductInput,
} from './reseller-catalog.service';

/** Every refusal of either door gets a status; a new reason does not compile until it gets one. */
const STATUS: Record<ResellerCatalogRejection, 400 | 403 | 404 | 409 | 503> = {
  // ResellerAccess (invariant 21): who may configure this reseller.
  not_allowed: 403,
  reseller_not_found: 404,
  reseller_suspended: 403,
  reseller_terminated: 409,
  // CatalogAdminService: what may be done to the catalog. The same statuses the
  // ambient surface answers, so one client reads both.
  not_platform_owner: 403,
  tenant_not_found: 404,
  category_not_found: 404,
  product_not_found: 404,
  variant_not_found: 404,
  panel_group_not_found: 404,
  price_not_found: 404,
  key_taken: 409,
  sku_taken: 409,
  price_in_the_past: 400,
  text_key_invalid: 400,
  texts_unavailable: 503,
  lang_unknown: 400,
  source_text_missing: 400,
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
 * `tenant.manage`, and the platform owner's staff. What may then be done is
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

  @Get('categories')
  @RateLimit(READ)
  async listCategories(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.catalog.listCategories(this.actor(req, ip), tenantId));
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
      const payload = { reason: e.reason, message: e.message };
      switch (STATUS[e.reason]) {
        case 403:
          throw new ForbiddenException(payload);
        case 404:
          throw new NotFoundException(payload);
        case 409:
          throw new ConflictException(payload);
        case 503:
          throw new ServiceUnavailableException(payload);
        default:
          throw new BadRequestException(payload);
      }
    }
  }
}
