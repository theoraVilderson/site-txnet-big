import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvelopeTranslator } from '@txnet-backend/shared-core';
import { createLocaleClient, type LocaleClient } from '@txnet/locale-client';
import { localeClientOptions } from '@txnet-backend/shared-core';

import type { EnvConfig } from '../config/env.validation';

/**
 * Thin adapter over the shared gRPC locale client — the translator the
 * `shared-core` envelope asks for. `billing-service`'s adapter without the
 * catalog's text writes.
 */
@Injectable()
export class LocaleService implements EnvelopeTranslator, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LocaleService.name);
  private readonly client: LocaleClient;
  private readonly defaultLanguage: string;

  constructor(config: ConfigService<EnvConfig, true>) {
    this.defaultLanguage = config.get('DEFAULT_LANGUAGE', { infer: true });
    this.client = createLocaleClient(localeClientOptions(config, this.logger, this.defaultLanguage));
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

  getKey(lang: string, namespace: string, key: string): string | undefined {
    return this.client.namespace(lang, namespace)?.[key];
  }

  getDefaultLanguage(): string {
    return this.defaultLanguage;
  }

  resolveLanguage(acceptLanguage?: string): string {
    return this.client.resolveLanguage(acceptLanguage);
  }
}
