import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { itemTextStoreOf, localeClientOptions, type EnvelopeTranslator, type ItemTextStore } from '@txnet-backend/shared-core';
import { createLocaleClient, type LocaleClient } from '@txnet/locale-client';

import type { EnvConfig } from '../config/env.validation';

/**
 * Thin adapter over the shared gRPC locale client — the translator the
 * `shared-core` envelope asks for (`EnvelopeTranslator`). `locale-service` is
 * the source of truth; nothing here reads a file.
 *
 * What the envelope and the language middleware call, plus the catalog's
 * runtime text writes (`textStore()`, F-1533-d). `bot-service`'s
 * adapter is the model; the two stay per app because `shared-core` holds no
 * gRPC client.
 */
@Injectable()
export class LocaleService
  implements EnvelopeTranslator, OnModuleInit, OnModuleDestroy
{
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

  /** The runtime text overlay, as shared-core's item text writer takes it (ADR-0154 decision 6). */
  textStore(): ItemTextStore {
    return itemTextStoreOf(this.client, this.defaultLanguage);
  }
}
