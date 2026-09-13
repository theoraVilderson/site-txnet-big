import {
  Body,
  Controller,
  ForbiddenException,
  Ip,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ImpersonationService } from './impersonation.service';
import { AuthGuard } from '../auth/auth.guard';
import { PermissionsGuard } from './guards/permissions.guard';

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

  @Post('impersonate/end')
  @UseGuards(AuthGuard)
  async end(@Req() req: any, @Ip() ip: string) {
    const sessionId = req.user.sessionId;
    const adminId = req.user.impersonatedBy;
    if (!adminId) throw new ForbiddenException('Not impersonated');
    return this.impersonationService.endImpersonation(sessionId, adminId, ip);
  }
}
