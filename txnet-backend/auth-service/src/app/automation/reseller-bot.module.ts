import { Module } from '@nestjs/common';
import { MessengerModule } from '@txnet-backend/messenger';
import { ResellerAccess } from '@txnet-backend/shared-core';
import { AuthModule } from '../auth/auth.module';
import { VaultModule } from '../tenant/vault/vault.module';
import { AutomationModule } from './automation.module';
import { ResellerBotController } from './reseller-bot.controller';
import { ResellerBotService } from './reseller-bot.service';

/**
 * A named reseller's bots (F-066-w5, ADR-0064).
 *
 * A module beside `AutomationModule` for the reason `WebhookRotationModule`
 * gives: this needs a bot *driver*, and `AutomationModule` is what supplies
 * `messenger` with its directory — one module holding both would make that
 * pair circular.
 *
 * `AuthModule` for `AuthGuard`'s own dependencies, since a guard is
 * constructed in the module owning the route. `VaultModule` because connecting
 * a bot writes two credentials and retiring one revokes them. `ResellerAccess`
 * is provided here rather than globally; its reader is bound once, beside the
 * pools in `PrismaModule`.
 */
@Module({
  imports: [
    AuthModule,
    AutomationModule,
    VaultModule,
    MessengerModule.forRoot({ imports: [AutomationModule] }),
  ],
  controllers: [ResellerBotController],
  providers: [ResellerBotService, ResellerAccess],
})
export class ResellerBotModule {}
