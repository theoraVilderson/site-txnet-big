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
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';
import { RateLimit } from '../request/rate-limit';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { CATALOG_ADMIN_READ as READ, CATALOG_ADMIN_WRITE as WRITE } from './catalog-admin.rate-limit';
import {
  CreateCapabilityBody,
  CreateCategoryBody,
  CreateProductBody,
  CreateVariantBody,
  EditTextsBody,
  ListProductsQuery,
  ListTextDraftsQuery,
  PublishTextsBody,
  RemoveCategoriesBody,
  ListCategoriesQuery,
  RemoveProductsBody,
  SetPriceBody,
  UpdateCapabilityBody,
  UpdateCategoryBody,
  UpdateProductBody,
  UpdateVariantBody,
  createCapabilitySchema,
  createCategorySchema,
  createProductSchema,
  createVariantSchema,
  editTextsSchema,
  listProductsSchema,
  listTextDraftsSchema,
  publishTextsSchema,
  removeCategoriesSchema,
  listCategoriesSchema,
  removeProductsSchema,
  setPriceSchema,
  updateCapabilitySchema,
  updateCategorySchema,
  updateProductSchema,
  updateVariantSchema,
} from './catalog-admin.schema';
import {
  CatalogActor,
  CatalogAdminRefused,
  CatalogAdminRejection,
  CatalogAdminService,
  CreateCapabilityInput,
  CreateCategoryInput,
  CreateProductInput,
  CreateVariantInput,
  EditTextsInput,
  PublishTextsInput,
  SetPriceInput,
  UpdateCapabilityInput,
  UpdateCategoryInput,
  UpdateProductInput,
} from './catalog-admin.service';
import { CatalogPermissionGuard } from './catalog-permission.guard';

/** Every refusal gets a status; a new reason does not compile until it gets one. */
export const CATALOG_REFUSAL_STATUS: Record<CatalogAdminRejection, 400 | 403 | 404 | 409 | 503> = {
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
  category_cycle: 409,
  category_too_deep: 400,
  capability_not_found: 404,
  capability_unknown: 400,
  capability_in_use: 409,
};


/**
 * Catalog management (F-026-d, D-34): `/api/catalog`, served by billing-service
 * (ADR-0049) on its own Traefik route — the user's call, 2026-09-14.
 *
 * One surface for two audiences, told apart by the tenant, never by the path:
 * the platform owner manages platform items and every tenant's, any other
 * tenant its own. `CatalogPermissionGuard` is the first door and the service
 * the real one. Nothing here deletes but `POST /products/remove` (F-026-h),
 * and it deletes only a product nothing references; the rest is switched off.
 */
@Controller('catalog')
@UseGuards(CatalogPermissionGuard)
export class CatalogAdminController {
  constructor(private readonly catalog: CatalogAdminService) {}

  private actor(req: Request, ip: string): CatalogActor {
    const { userId, tenantId } = identityOf(req);
    return { adminId: userId, tenantId, ip };
  }

  /** F-026-p: the groups a variant may name — the platform's and the caller's own; every group, with its tenant, for the platform owner. */
  @Get('panel-groups')
  @RateLimit(READ)
  async listPanelGroups(@Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.catalog.listPanelGroups(this.actor(req, ip)));
  }

  @Get('categories')
  @RateLimit(READ)
  async listCategories(@Query(new ZodValidationPipe(listCategoriesSchema)) query: ListCategoriesQuery, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.catalog.listCategories(this.actor(req, ip), query));
  }

  @Post('categories')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE)
  async createCategory(@Body(new ZodValidationPipe(createCategorySchema)) body: CreateCategoryBody, @Req() req: Request, @Ip() ip: string) {
    // The casts are for this project's non-strict tsconfig, under which zod infers every key as optional.
    return this.refusing(() => this.catalog.createCategory(this.actor(req, ip), body as CreateCategoryInput));
  }

  @Patch('categories/:id')
  @RateLimit(WRITE)
  async updateCategory(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateCategorySchema)) body: UpdateCategoryBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return this.refusing(() => this.catalog.updateCategory(this.actor(req, ip), id, body as UpdateCategoryInput));
  }

  /** F-026-j: one outcome per id — `deleted`, `has_products`, or `not_found`; F-026-l: `withProducts` adds `archived`. */
  @Post('categories/remove')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE)
  async removeCategories(@Body(new ZodValidationPipe(removeCategoriesSchema)) body: RemoveCategoriesBody, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.catalog.removeCategories(this.actor(req, ip), body.ids as string[], body.withProducts === true));
  }

  /** F-114-f-a: the platform's capabilities and the caller's own; every one, with its tenant, for the platform owner. */
  @Get('capabilities')
  @RateLimit(READ)
  async listCapabilities(@Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.catalog.listCapabilities(this.actor(req, ip)));
  }

  @Post('capabilities')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE)
  async createCapability(@Body(new ZodValidationPipe(createCapabilitySchema)) body: CreateCapabilityBody, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.catalog.createCapability(this.actor(req, ip), body as CreateCapabilityInput));
  }

  @Patch('capabilities/:id')
  @RateLimit(WRITE)
  async updateCapability(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateCapabilitySchema)) body: UpdateCapabilityBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return this.refusing(() => this.catalog.updateCapability(this.actor(req, ip), id, body as UpdateCapabilityInput));
  }

  /** Deleted, or `capability_in_use` while a product or a Grant holds its key. */
  @Post('capabilities/:id/remove')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE)
  async removeCapability(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.catalog.removeCapability(this.actor(req, ip), id));
  }

  @Get('products')
  @RateLimit(READ)
  async listProducts(@Query(new ZodValidationPipe(listProductsSchema)) query: ListProductsQuery, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.catalog.listProducts(this.actor(req, ip), query));
  }

  @Post('products')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE)
  async createProduct(@Body(new ZodValidationPipe(createProductSchema)) body: CreateProductBody, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.catalog.createProduct(this.actor(req, ip), body as CreateProductInput));
  }

  /** F-026-h: one outcome per id — `deleted`, `archived`, or `not_found`. */
  @Post('products/remove')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE)
  async removeProducts(@Body(new ZodValidationPipe(removeProductsSchema)) body: RemoveProductsBody, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.catalog.removeProducts(this.actor(req, ip), body.ids as string[]));
  }

  @Get('products/:id')
  @RateLimit(READ)
  async getProduct(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.catalog.getProduct(this.actor(req, ip), id));
  }

  @Patch('products/:id')
  @RateLimit(WRITE)
  async updateProduct(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateProductSchema)) body: UpdateProductBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return this.refusing(() => this.catalog.updateProduct(this.actor(req, ip), id, body as UpdateProductInput));
  }

  @Post('products/:id/variants')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE)
  async createVariant(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(createVariantSchema)) body: CreateVariantBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return this.refusing(() => this.catalog.createVariant(this.actor(req, ip), id, body as CreateVariantInput));
  }

  @Patch('variants/:id')
  @RateLimit(WRITE)
  async updateVariant(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateVariantSchema)) body: UpdateVariantBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return this.refusing(() => this.catalog.updateVariant(this.actor(req, ip), id, body));
  }

  @Post('variants/:id/prices')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE)
  async setPrice(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(setPriceSchema)) body: SetPriceBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return this.refusing(() => this.catalog.setPrice(this.actor(req, ip), id, body as SetPriceInput));
  }

  @Post('prices/:id/deactivate')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE)
  async deactivatePrice(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.catalog.deactivatePrice(this.actor(req, ip), id));
  }

  // ---------------------------------------------------- translations (F-1533-d)

  @Get('translations')
  @RateLimit(READ)
  async listTextDrafts(@Query(new ZodValidationPipe(listTextDraftsSchema)) query: ListTextDraftsQuery, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.catalog.listTextDrafts(this.actor(req, ip), query.lang));
  }

  @Post('translations/draft-missing')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE)
  async draftMissingTexts(@Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.catalog.draftMissingTexts(this.actor(req, ip)));
  }

  @Post('translations/publish')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE)
  async publishTextDrafts(@Body(new ZodValidationPipe(publishTextsSchema)) body: PublishTextsBody, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.catalog.publishTextDrafts(this.actor(req, ip), body as PublishTextsInput));
  }

  @Patch('translations')
  @RateLimit(WRITE)
  async editTexts(@Body(new ZodValidationPipe(editTextsSchema)) body: EditTextsBody, @Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.catalog.editTexts(this.actor(req, ip), body as EditTextsInput));
  }

  private async refusing<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      if (!(e instanceof CatalogAdminRefused)) throw e;
      const payload = { reason: e.reason, message: e.message };
      switch (CATALOG_REFUSAL_STATUS[e.reason]) {
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
