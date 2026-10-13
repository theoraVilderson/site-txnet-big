import { Controller, Get, HttpCode, HttpStatus, Req, UseGuards } from '@nestjs/common';
import { requestLanguage } from '@txnet-backend/shared-core';
import { Request } from 'express';

import { AuthGuard } from '../auth.guard';
import { LocaleService } from '../../locale/locale.service';
import { PermissionRegistryService } from './permission-registry.service';

/**
 * `GET /api/auth/permissions` (AC-1-f): every permission key the platform
 * knows, grouped by area, with its text in the request's language. Any signed
 * in caller: the vocabulary is not a secret, and what a caller may *grant* is
 * answered where it is decided (`grantable` on a tenant's roles, ADR-0134).
 */
@Controller('auth/permissions')
@UseGuards(AuthGuard)
export class PermissionRegistryController {
  constructor(
    private readonly registry: PermissionRegistryService,
    private readonly locale: LocaleService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  list(@Req() req: Request) {
    return this.registry.list(requestLanguage(req, this.locale));
  }
}
