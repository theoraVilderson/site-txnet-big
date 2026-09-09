import {
  Controller,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { isBotPlatform } from '@txnet-backend/messenger';
import { AuthGuard } from '../auth/auth.guard';
import { PermissionsGuard } from '../impersonation/guards/permissions.guard';
import { TenantContext } from '../tenant-context/tenant-context';
import { PrismaBotIntegrationDirectory } from './bot-integration.directory';
import { WebhookRotationService } from './webhook-rotation.service';

/**
 * Rotate a bot's webhook path (F-322, catalog 10.2).
 *
 * An admin route rather than a tenant one because the tenant panel does not
 * exist yet (F-018). It is the same service that panel will call, and the
 * scoping is already the tenant's: the integration is looked up by the bot's
 * `@handle` **within the tenant this request resolved to** (F-066-c), so
 * platform staff signed in on one brand's host cannot reach another brand's
 * bot by guessing a name.
 *
 * The address is never in the URL. A path is a credential, so it is neither an
 * input here — the bot is named by its handle — nor an output: the response
 * says the rotation happened and whether the platform accepted it, and the new
 * path reaches the operator through the bot working again.
 */
@Controller('admin/bots')
export class WebhookRotationController {
  constructor(
    private readonly directory: PrismaBotIntegrationDirectory,
    private readonly rotation: WebhookRotationService,
  ) {}

  @Post(':platform/:botUsername/webhook/rotate')
  @UseGuards(AuthGuard, new PermissionsGuard(['bot.webhook_rotate']))
  async rotate(
    @Req() req: { user?: { sub?: string } },
    @Param('platform') platform: string,
    @Param('botUsername') botUsername: string,
  ): Promise<{ rotated: true; registered: boolean; status: string }> {
    if (!isBotPlatform(platform)) throw new NotFoundException();
    const tenant = TenantContext.current('rotating a webhook path');
    const integration = await this.directory.byTenantBot(
      tenant.id,
      platform,
      botUsername.replace(/^@/, ''),
    );
    if (!integration) throw new NotFoundException();

    const result = await this.rotation.rotate(integration, req.user?.sub);
    return {
      rotated: true,
      registered: result.registered,
      status: result.integration.status,
    };
  }
}
