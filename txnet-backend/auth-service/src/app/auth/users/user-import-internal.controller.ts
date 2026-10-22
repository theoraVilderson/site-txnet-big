import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { TenantCapability, ZodValidationPipe } from '@txnet-backend/shared-core';
import { z } from 'zod';

import { ServiceOnlyGuard } from '../../common/guards/service-only.guard';
import type { ChatClaim } from '../bot-link/link-writes';
import { USER_IMPORT_BATCH_MAX, UserImportService, type SourceUser, type TelegramLinkAnswer, type UserImportAnswer, type UserRemovalAnswer } from './user-import.service';

/** A source panel's names are free text; these bound what one call may carry. */
const REMOTE_IDENTITY_MAX = 512;
const LABEL_MAX = 200;
/** A Telegram account id as the source names it: a positive 64-bit integer in decimal (network's `TelegramIDOf`). */
const telegramId = z.string().regex(/^[1-9]\d{0,18}$/);

export const userImportSchema = z.object({
  users: z
    .array(z.object({ remoteIdentity: z.string().trim().min(1).max(REMOTE_IDENTITY_MAX), label: z.string().max(LABEL_MAX), telegramId: telegramId.optional() }))
    .min(1)
    .max(USER_IMPORT_BATCH_MAX),
});

export const userRemovalSchema = z.object({ userIds: z.array(z.string().uuid()).min(1).max(USER_IMPORT_BATCH_MAX) });

export const telegramClaimSchema = z.object({ links: z.array(z.object({ userId: z.string().uuid(), chatId: telegramId })).min(1).max(USER_IMPORT_BATCH_MAX) });

/**
 * `POST /api/internal/users/import` (F-201-e, contract.import.md) — the seam an
 * import's commit (F-207, billing-service) finds or creates its users through;
 * `POST /api/internal/users/import/remove` the one its rollback (F-211) removes
 * the people it made through; `POST /api/internal/users/import/telegram` the
 * one a balance file's Telegram column claims its people's chats through (F-210).
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

  @Post('import/remove')
  @HttpCode(HttpStatus.OK)
  remove(@Body(new ZodValidationPipe(userRemovalSchema)) body: { userIds: string[] }): Promise<UserRemovalAnswer> {
    return this.imports.removeImported(body.userIds);
  }

  @Post('import/telegram')
  @HttpCode(HttpStatus.OK)
  claimTelegram(@Body(new ZodValidationPipe(telegramClaimSchema)) body: { links: ChatClaim[] }): Promise<TelegramLinkAnswer> {
    return this.imports.claimTelegram(body.links);
  }
}
