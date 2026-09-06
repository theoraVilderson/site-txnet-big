import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createLocaleClient, type LocaleClient } from '@txnet/locale-client';

/**
 * Thin adapter over the shared gRPC locale client. `locale-service` is the
 * source of truth for every string this bot says (ADR-0003); nothing here
 * reads a file and nothing here holds copy.
 */
@Injectable()
export class LocaleService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LocaleService.name);
  private readonly client: LocaleClient;
  private readonly defaultLanguage: string;

  constructor(config: ConfigService) {
    this.defaultLanguage = config.get<string>('DEFAULT_LANGUAGE', 'fa');
    this.client = createLocaleClient({
      addr: config.get<string>('LOCALE_SERVICE_ADDR', 'localhost:50051'),
      scope: config.get<string>('LOCALE_SCOPE', 'backend'),
      defaultLang: this.defaultLanguage,
      bootTimeoutMs: 60_000,
      logger: {
        log: (m) => this.logger.log(m),
        warn: (m) => this.logger.warn(m),
        error: (m) => this.logger.error(m),
      },
    });
  }

  async onModuleInit() {
    await this.client.ready();
    this.logger.log(
      `locale-service connected: langs=${this.client.languages().join(', ')}`,
    );
  }

  onModuleDestroy() {
    this.client.close();
  }

  /** Single value by flat (dot-notation) key, or undefined. */
  getKey(lang: string, namespace: string, key: string): unknown {
    return this.client.namespace(lang, namespace)?.[key];
  }

  /** Every language `locale-service` actually serves, with its native name. */
  locales() {
    return this.client.availableLocales();
  }

  /** The codes of those languages, from the cached snapshot. */
  languages(): string[] {
    return this.client.languages();
  }

  resolveLanguage(acceptLanguage?: string): string {
    return this.client.resolveLanguage(acceptLanguage);
  }

  getDefaultLanguage(): string {
    return this.defaultLanguage;
  }
}
