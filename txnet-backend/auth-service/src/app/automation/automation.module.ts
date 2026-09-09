import { Module } from '@nestjs/common';
import { BOT_INTEGRATION_DIRECTORY } from '@txnet-backend/messenger';
import { VaultModule } from '../tenant/vault/vault.module';
import { BotIntegrationController } from './bot-integration.controller';
import { PrismaBotIntegrationDirectory } from './bot-integration.directory';

/**
 * `automation`'s first module, and the first code to implement any of that
 * domain: the `BotIntegration` table and nothing else (F-315, F-316, F-320).
 *
 * It exports the directory under the token `messenger` asks for, so this
 * process's `MessengerModule` is wired to the schema and the vault directly —
 * see `MessengerModule.forRoot`.
 */
@Module({
  imports: [VaultModule],
  controllers: [BotIntegrationController],
  providers: [
    PrismaBotIntegrationDirectory,
    {
      provide: BOT_INTEGRATION_DIRECTORY,
      useExisting: PrismaBotIntegrationDirectory,
    },
  ],
  exports: [PrismaBotIntegrationDirectory, BOT_INTEGRATION_DIRECTORY],
})
export class AutomationModule {}
