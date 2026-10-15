import { Body, Controller, HttpCode, HttpStatus, Ip, Param, ParseUUIDPipe, Post, Put, Req } from '@nestjs/common';
import type { Request } from 'express';

import { ZodValidationPipe } from '../../request/zod-validation.pipe';
import { GrantReasonBody, grantReasonSchema } from './grant-audit.schema';
import { GrantFreezeBody, GrantFreezeModeBody, grantFreezeModeSchema, grantFreezeSchema } from './grant-freeze.schema';
import { actionLimit, adminOf, grantActRefusal } from './reseller-user-grants.controller';
import { ResellerUserGrantsService } from './reseller-user-grants.service';

/**
 * An admin freezes, unfreezes and re-modes one of this user's Grants (F-311-h,
 * F-0401-d) — the rest of the user sheet's acts are `ResellerUserGrantsController`'s,
 * whose door, bucket and refusals these share. The config actions' bucket:
 * all are an admin's writes on a user's service.
 */
@Controller('billing/tenants/:tenantId/users/:userId/grants/:grantId')
export class ResellerGrantFreezeController {
  constructor(private readonly service: ResellerUserGrantsService) {}

  /**
   * Its configs off, kept — never purged. `until` unfreezes it by itself;
   * `mode` is who may: `hard` (absent) only an admin, `soft` the user too.
   */
  @Post('freeze')
  @HttpCode(HttpStatus.OK)
  @actionLimit
  async freeze(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('grantId', new ParseUUIDPipe()) grantId: string,
    @Body(new ZodValidationPipe(grantFreezeSchema)) body: GrantFreezeBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    const input = { until: body.until ? new Date(body.until) : null, mode: body.mode };
    const done = await this.refusing(() => this.service.freeze(adminOf(req, ip), tenantId, userId, grantId, input, body.reason ?? null));
    return { grantId, frozenUntil: done.frozenUntil?.toISOString() ?? null, configsDisabled: done.configsDisabled, freezeMode: done.freezeMode };
  }

  /** And unfreezes it: its end moves by the time its clock stood still. */
  @Post('unfreeze')
  @HttpCode(HttpStatus.OK)
  @actionLimit
  async unfreeze(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('grantId', new ParseUUIDPipe()) grantId: string,
    @Body(new ZodValidationPipe(grantReasonSchema)) body: GrantReasonBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    const done = await this.refusing(() => this.service.unfreeze(adminOf(req, ip), tenantId, userId, grantId, body.reason ?? null));
    return { grantId, endsAt: done.endsAt?.toISOString() ?? null, configsRestored: done.configsRestored };
  }

  /** Changes who may lift a frozen Grant (F-0401-d): its mode alone, the clock and configs as they are. */
  @Put('freeze-mode')
  @actionLimit
  async setMode(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('grantId', new ParseUUIDPipe()) grantId: string,
    @Body(new ZodValidationPipe(grantFreezeModeSchema)) body: GrantFreezeModeBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    const done = await this.refusing(() => this.service.setFreezeMode(adminOf(req, ip), tenantId, userId, grantId, body.mode, body.reason ?? null));
    return { grantId, ...done };
  }

  private async refusing<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw grantActRefusal(e);
    }
  }
}
