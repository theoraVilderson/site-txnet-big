import { DynamicModule, Module, ModuleMetadata } from '@nestjs/common';
import { BotClientRegistry } from './bot-client.registry';
import { BotViewRenderer } from './renderer';

/**
 * The messenger platform unit, as a Nest module. Two consumers import it:
 * `auth-service` (OTP delivery to a proven chat) and `bot-service` (every
 * screen) — which is what makes this a `platform/` unit rather than part of
 * `bot-app` (ADR-0009).
 *
 * It takes its `BotIntegrationDirectory` from whoever imports it, because the
 * two consumers are not equal below that seam (F-320): `auth-service` owns the
 * schema and the vault and answers directly, while `bot-service` has neither
 * and asks over `X-Service-Token` (ADR-0011). There is deliberately no default
 * binding — an app that forgot to supply one would still boot, and the failure
 * would arrive on the first inbound update rather than at wiring.
 */
@Module({})
export class MessengerModule {
  static forRoot(options: {
    /**
     * Modules exporting `BOT_INTEGRATION_DIRECTORY`. Supplying it as a module
     * rather than a provider keeps it one instance: the app that owns the
     * implementation usually needs it for itself as well.
     */
    imports: ModuleMetadata['imports'];
  }): DynamicModule {
    return {
      module: MessengerModule,
      imports: options.imports,
      providers: [BotClientRegistry, BotViewRenderer],
      exports: [BotClientRegistry, BotViewRenderer],
    };
  }
}
