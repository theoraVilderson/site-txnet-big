import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvelopeTranslator } from '@txnet-backend/shared-core';
import { createLocaleClient, type LocaleClient } from '@txnet/locale-client';

import type { CatalogTextStore } from '../catalog/catalog-texts';

import type { EnvConfig } from '../config/env.validation';

/**
 * Thin adapter over the shared gRPC locale client — the translator the
 * `shared-core` envelope asks for (`EnvelopeTranslator`). `locale-service` is
 * the source of truth; nothing here reads a file.
 *
 * What the envelope and the language middleware call, plus the catalog's
 * runtime text writes (`CatalogTextStore`, F-1533-d). `bot-service`'s
 * adapter is the model; the two stay per app because `shared-core` holds no
 * gRPC client.
 */
@Injectable()
export class LocaleService
  implements EnvelopeTranslator, CatalogTextStore, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(LocaleService.name);
  private readonly client: LocaleClient;
  private readonly defaultLanguage: string;

  constructor(config: ConfigService<EnvConfig, true>) {
    this.defaultLanguage = config.get('DEFAULT_LANGUAGE', { infer: true });
    this.client = createLocaleClient({
      addr: config.get('LOCALE_SERVICE_ADDR', { infer: true }),
      scope: config.get('LOCALE_SCOPE', { infer: true }),
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

  getKey(lang: string, namespace: string, key: string): string | undefined {
    return this.client.namespace(lang, namespace)?.[key];
  }

  getDefaultLanguage(): string {
    return this.defaultLanguage;
  }

  resolveLanguage(acceptLanguage?: string): string {
    return this.client.resolveLanguage(acceptLanguage);
  }

  // Catalog text (F-1533-d): the runtime overlay's calls, as the client has them.

  languages(): string[] {
    return this.client.languages();
  }

  namespace(lang: string, namespace: string): Record<string, string> | undefined {
    return this.client.namespace(lang, namespace);
  }

  setEntries(target: Parameters<LocaleClient['setEntries']>[0]): Promise<number> {
    return this.client.setEntries(target);
  }

  listDrafts(filter?: Parameters<LocaleClient['listDrafts']>[0]) {
    return this.client.listDrafts(filter);
  }

  publishDrafts(target: Parameters<LocaleClient['publishDrafts']>[0]): Promise<number> {
    return this.client.publishDrafts(target);
  }
}
