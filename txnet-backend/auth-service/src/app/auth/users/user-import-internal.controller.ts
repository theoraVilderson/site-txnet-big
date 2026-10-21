import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { TenantCapability, ZodValidationPipe } from '@txnet-backend/shared-core';
import { z } from 'zod';

import { ServiceOnlyGuard } from '../../common/guards/service-only.guard';
import { USER_IMPORT_BATCH_MAX, UserImportService, type SourceUser, type UserImportAnswer } from './user-import.service';

/** A source panel's names are free text; these bound what one call may carry. */
const REMOTE_IDENTITY_MAX = 512;
const LABEL_MAX = 200;

export const userImportSchema = z.object({
  users: z
    .array(z.object({ remoteIdentity: z.string().trim().min(1).max(REMOTE_IDENTITY_MAX), label: z.string().max(LABEL_MAX) }))
    .min(1)
    .max(USER_IMPORT_BATCH_MAX),
});

/**
 * `POST /api/internal/users/import` (F-201-e, contract.import.md) — the seam an
 * import's commit (F-207, billing-service) finds or creates its users through.
 * Service callers only (a neutral 404 otherwise); the tenant is `X-Tenant-Id`,
 * honoured because the service token verified. `staffWrite`: the import is the
 * reseller's own act, closed when its staff could not write either.
 */
@TenantCapability('staffWrite')
@Controller('internal/users')
@UseGuards(ServiceOnlyGuard)
export class UserImportInternalController {
  constructor(private readonly imports: UserImportService) {}

  @Post('import')
  @HttpCode(HttpStatus.OK)
  findOrCreate(@Body(new ZodValidationPipe(userImportSchema)) body: { users: SourceUser[] }): Promise<UserImportAnswer> {
    return this.imports.findOrCreate(body.users);
  }
}
