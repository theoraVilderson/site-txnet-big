import {
  Body,
  Controller,
  ForbiddenException,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { accessTraceOf, TenantCapability } from '@txnet-backend/shared-core';
import { ImpersonationService } from './impersonation.service';
import { AuthGuard } from '../auth/auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';

/**
 * Impersonation start and end, under `/auth` — a role word never belongs in a URL — authority is the caller's
 * permissions, and the path names the service that hosts the route. The `/admin` spelling was
 * removed by F-099 (2026-09-13).
 */
@Controller('auth')
export class ImpersonationController {
  constructor(private readonly impersonationService: ImpersonationService) {}

  @Post('users/:userId/impersonate')
  @UseGuards(AuthGuard, new PermissionsGuard(['user.impersonate']))
  async impersonate(
    @Req() req: any,
    @Body('reasonNote') reasonNote: string,
    @Ip() ip: string,
  ) {
    const adminId = req.user.sub;
    const targetUserId = req.params.userId;
    const userAgent = req.get('user-agent') ?? 'unknown';
    return this.impersonationService.startImpersonation(
      adminId,
      targetUserId,
      reasonNote,
      ip,
      userAgent,
    );
  }

  /**
   * A reseller's user, by the platform's staff (F-117-e, ADR-0104): only under
   * the reseller's live `act` consent or the caller's own emergency entry —
   * `ResellerAccess` decides, in the service. Refusals are 403 `{reason}`
   * (`consent_required`, `consent_read_only`, `not_allowed`, …).
   */
  @Post('tenants/:tenantId/users/:userId/impersonate')
  @UseGuards(AuthGuard, new PermissionsGuard(['platform.impersonate']))
  async impersonateResellerUser(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Req() req: any,
    @Body('reasonNote') reasonNote: string,
    @Ip() ip: string,
  ) {
    const user = req.user;
    const actor = { userId: user.sub, tenantId: user.tenantId, permissions: user.permissions ?? [], trace: accessTraceOf(req) };
    return this.impersonationService.startForReseller(actor, tenantId, userId, reasonNote, ip, req.get('user-agent') ?? 'unknown');
  }

  @TenantCapability('signOut')
  @Post('impersonate/end')
  @UseGuards(AuthGuard)
  async end(@Req() req: any, @Ip() ip: string) {
    const sessionId = req.user.sessionId;
    const adminId = req.user.impersonatedBy;
    if (!adminId) throw new ForbiddenException('Not impersonated');
    return this.impersonationService.endImpersonation(sessionId, adminId, ip);
  }
}
