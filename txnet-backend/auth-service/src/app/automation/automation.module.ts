import { forwardRef, Module } from '@nestjs/common';
import { BOT_INTEGRATION_DIRECTORY } from '@txnet-backend/messenger';
import { AuthModule } from '../auth/auth.module';
import { VaultModule } from '../tenant/vault/vault.module';
import { BotIntegrationController } from './bot-integration.controller';
import { AuthBrokerPublisher } from './broker.publisher';
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
  // `AuthModule` because `WorkerAdminController` is behind `AuthGuard`, which
  // needs `TokenService` and `SessionStore` — a guard resolves its
  // dependencies in the module that declares the controller, not in the one
  // that declares the guard. `forwardRef` because `AuthModule` already imports
  // this one for `AuthBrokerPublisher` (F-067-a), so the two are genuinely
  // circular and Nest needs to be told.
  //
  // Missing since F-031-b, which added the controller. No unit spec could
  // catch it — they construct classes directly and never build the injector —
  // and the whole process failed to boot, which is what the e2e tier found the
  // first time it was run after that row.
  imports: [VaultModule, forwardRef(() => AuthModule)],
  controllers: [BotIntegrationController, WorkerAdminController],
  providers: [
    PrismaBotIntegrationDirectory,
    AuthBrokerPublisher,
    ManualTickPublisher,
    WorkerAdminService,
    {
      provide: BOT_INTEGRATION_DIRECTORY,
      useExisting: PrismaBotIntegrationDirectory,
    },
  ],
  // `AuthBrokerPublisher` is exported because identity publishes too since
  // F-067-a, and one process gets one connection to the broker.
  exports: [
    PrismaBotIntegrationDirectory,
    BOT_INTEGRATION_DIRECTORY,
    AuthBrokerPublisher,
  ],
})
export class AutomationModule {}
