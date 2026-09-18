import {
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
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';
import { TenantPermissionGuard } from '../request/tenant-permission.guard';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { CreateResellerInput, ListResellersInput, createResellerSchema, listResellersSchema } from './reseller.schema';
import { ResellerActor, ResellerRefused, ResellerRejection, ResellerService, ResellerView } from './reseller.service';

/** Every refusal gets a status; a new reason does not compile until it gets one. */
const STATUS: Record<ResellerRejection, 403 | 404 | 409> = {
  not_platform_owner: 403,
  reseller_not_found: 404,
  owner_not_found: 404,
  slug_taken: 409,
  owner_inactive: 409,
};

/**
 * The platform owner's reseller administration (F-018-c):
 * `POST /api/tenants`, `GET /api/tenants`, `GET /api/tenants/:id`.
 *
 * Moved out of `auth-service` with F-018-y (ADR-0058): the paths lost their
 * `/auth` prefix, the caller is whoever `forward-auth` proved, and creation
 * names an existing user as the owner instead of creating one.
 */
@Controller('tenants')
@UseGuards(TenantPermissionGuard)
export class ResellerController {
  constructor(private readonly resellers: ResellerService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Req() req: Request,
    @Body(new ZodValidationPipe(createResellerSchema)) body: CreateResellerInput,
    @Ip() ip: string,
  ): Promise<ResellerView> {
    return this.refusing(() => this.resellers.create(actorOf(req, ip), body));
  }

  @Get()
  async list(
    @Req() req: Request,
    @Query(new ZodValidationPipe(listResellersSchema)) page: ListResellersInput,
    @Ip() ip: string,
  ): Promise<ResellerView[]> {
    return this.refusing(() => this.resellers.list(actorOf(req, ip), page));
  }

  @Get(':id')
  async read(@Req() req: Request, @Param('id', new ParseUUIDPipe()) id: string, @Ip() ip: string): Promise<ResellerView> {
    return this.refusing(() => this.resellers.read(actorOf(req, ip), id));
  }

  private async refusing<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (e) {
      if (!(e instanceof ResellerRefused)) throw e;
      const payload = { reason: e.reason, message: e.message };
      switch (STATUS[e.reason]) {
        case 403:
          throw new ForbiddenException(payload);
        case 404:
          throw new NotFoundException(payload);
        default:
          throw new ConflictException(payload);
      }
    }
  }
}

function actorOf(req: Request, ip: string): ResellerActor {
  const identity = identityOf(req);
  return { adminId: identity.userId, tenantId: identity.tenantId, ip };
}
