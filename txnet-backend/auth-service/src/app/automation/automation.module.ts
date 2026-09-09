import { Module } from '@nestjs/common';
import { BOT_INTEGRATION_DIRECTORY } from '@txnet-backend/messenger';
import { VaultModule } from '../tenant/vault/vault.module';
import { BotIntegrationController } from './bot-integration.controller';
import { ManualTickPublisher } from './manual-tick.publisher';
import { WorkerAdminController } from './worker-admin.controller';
import { WorkerAdminService } from './worker-admin.service';
import { PrismaBotIntegrationDirectory } from './bot-integration.directory';

/**
 * `automation`'s first module, and the first code to implement any of that
 * domain: the `BotIntegration` table and nothing else (F-315, F-316, F-320).
 *
 * It exports the directory under the token `messenger` asks for, so this
 * process's `MessengerModule` is wired to the schema and the vault directly —
 * see `MessengerModule.forRoot`.
 *
 * Since F-031-b it also carries the admin surface over the worker registry.
 * The workers themselves run in `worker-service`, which serves no HTTP by
 * design (ADR-0027) — so the routes that write `bot_worker.isActive` and
 * `bot_schedule` live in the process that already holds an authenticated
 * admin, and the two meet at the three tables and one exchange.
 */
@Module({
  imports: [VaultModule],
  controllers: [BotIntegrationController, WorkerAdminController],
  providers: [
    PrismaBotIntegrationDirectory,
    ManualTickPublisher,
    WorkerAdminService,
    {
      provide: BOT_INTEGRATION_DIRECTORY,
      useExisting: PrismaBotIntegrationDirectory,
    },
  ],
  exports: [PrismaBotIntegrationDirectory, BOT_INTEGRATION_DIRECTORY],
})
export class AutomationModule {}
