import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { ResellerLimitReached } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { AddDomainInput, addDomainSchema } from './tenant-domain.schema';
import { DomainActor, DomainRefused, DomainRejection, DomainView, TenantDomainService } from './tenant-domain.service';

/** Every refusal gets a status; a new reason does not compile until it gets one. */
const STATUS: Record<DomainRejection, 403 | 404 | 409> = {
  not_allowed: 403,
  reseller_not_found: 404,
  reseller_suspended: 403,
  domain_not_found: 404,
  reseller_terminated: 409,
  domain_taken: 409,
  domain_reserved: 409,
};

/**
 * A reseller's custom domains (F-018-i): `GET` / `POST /api/tenants/:id/domains`
 * and `POST /api/tenants/:id/domains/:domainId/check`.
 *
 * No `TenantPermissionGuard`: the reseller's owner holds no `tenant.manage`,
 * and is let in by `ResellerAccess` (F-061-h), as the platform owner's staff are.
 */
@Controller('tenants/:id/domains')
export class TenantDomainController {
  constructor(private readonly domains: TenantDomainService) {}

  @Get()
  list(@Req() req: Request, @Param('id', new ParseUUIDPipe()) id: string): Promise<DomainView[]> {
    return this.refusing(() => this.domains.list(actorOf(req), id));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  add(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(addDomainSchema)) body: AddDomainInput,
  ): Promise<DomainView> {
    return this.refusing(() => this.domains.add(actorOf(req), id, body));
  }

  @Post(':domainId/check')
  @HttpCode(HttpStatus.OK)
  check(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('domainId', new ParseUUIDPipe()) domainId: string,
  ): Promise<DomainView> {
    return this.refusing(() => this.domains.requestCheck(actorOf(req), id, domainId));
  }

  private async refusing<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (e) {
      // Past the reseller's limit on custom domains (F-019-q): its figures, so it knows what to ask to raise.
      if (e instanceof ResellerLimitReached) throw new ConflictException({ reason: e.reason, message: e.message, facts: e.facts });
      if (!(e instanceof DomainRefused)) throw e;
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

function actorOf(req: Request): DomainActor {
  const { userId, tenantId, permissions } = identityOf(req);
  return { userId, tenantId, permissions };
}
