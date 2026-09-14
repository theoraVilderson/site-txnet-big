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
  UseGuards,
} from '@nestjs/common';
import { RateLimitBucket, rateLimitBucketKey } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';
import { RateLimit } from '../request/rate-limit';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import {
  CreateCategoryBody,
  CreateProductBody,
  CreateVariantBody,
  ListProductsQuery,
  SetPriceBody,
  UpdateCategoryBody,
  UpdateProductBody,
  UpdateVariantBody,
  createCategorySchema,
  createProductSchema,
  createVariantSchema,
  listProductsSchema,
  setPriceSchema,
  updateCategorySchema,
  updateProductSchema,
  updateVariantSchema,
} from './catalog-admin.schema';
import {
  CatalogActor,
  CatalogAdminRefused,
  CatalogAdminRejection,
  CatalogAdminService,
  CreateCategoryInput,
  CreateProductInput,
  CreateVariantInput,
  SetPriceInput,
} from './catalog-admin.service';
import { CatalogPermissionGuard } from './catalog-permission.guard';

/** Every refusal gets a status; a new reason does not compile until it gets one. */
export const CATALOG_REFUSAL_STATUS: Record<CatalogAdminRejection, 400 | 403 | 404 | 409> = {
  not_platform_owner: 403,
  tenant_not_found: 404,
  category_not_found: 404,
  product_not_found: 404,
  variant_not_found: 404,
  price_not_found: 404,
  key_taken: 409,
  sku_taken: 409,
  price_in_the_past: 400,
};

const READ = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.CATALOG_ADMIN_READ, identityOf(req).userId),
  configKey: 'CATALOG_ADMIN_READ_RATE_LIMIT' as const,
  windowSec: 900,
};
const WRITE = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.CATALOG_ADMIN_WRITE, identityOf(req).userId),
  configKey: 'CATALOG_ADMIN_WRITE_RATE_LIMIT' as const,
  windowSec: 900,
};

/**
 * Catalog management (F-026-d, D-34): `/api/catalog`, served by billing-service
 * (ADR-0049) on its own Traefik route — the user's call, 2026-09-14.
 *
 * One surface for two audiences, told apart by the tenant, never by the path:
 * the platform owner manages platform items and every tenant's, any other
 * tenant its own. `CatalogPermissionGuard` is the first door and the service
 * the real one. Nothing here deletes: an item or a price is switched off.
 */
@Controller('catalog')
@UseGuards(CatalogPermissionGuard)
export class CatalogAdminController {
  constructor(private readonly catalog: CatalogAdminService) {}

  private actor(req: Request, ip: string): CatalogActor {
    const { userId, tenantId } = identityOf(req);
    return { adminId: userId, tenantId, ip };
  }

  @Get('categories')
  @RateLimit(READ)
  async listCategories(@Req() req: Request, @Ip() ip: string) {
    return this.refusing(() => this.catalog.listCategories(this.actor(req, ip)));
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
    return this.refusing(() => this.catalog.updateCategory(this.actor(req, ip), id, body));
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
    return this.refusing(() => this.catalog.updateProduct(this.actor(req, ip), id, body));
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
        default:
          throw new BadRequestException(payload);
      }
    }
  }
}
