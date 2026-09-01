import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createLocaleClient, type LocaleClient } from '@txnet/locale-client';

type Namespace = Record<string, any>;
type LocaleData = Record<string, Record<string, Namespace>>;

/**
 * LocaleService is a thin adapter over the vendored gRPC locale client.
 * locale-service (Go) is the source of truth; this process keeps a live
 * in-memory cache of the "backend" scope and never touches the filesystem.
 *
 * The public method set is unchanged so callers (filters, interceptors, OTP
 * senders, i18n controller) keep working. Keys coming back from gRPC are
 * flattened dot-notation; getNamespace() re-nests them for the OTP builders
 * that expect a tree.
 */
@Injectable()
export class LocaleService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LocaleService.name);
  private readonly client: LocaleClient;
  private readonly defaultLanguage: string;

  constructor(private readonly configService: ConfigService) {
    const addr = this.configService.get<string>(
      'LOCALE_SERVICE_ADDR',
      'localhost:50051',
    );
    const scope = this.configService.get<string>('LOCALE_SCOPE', 'backend');
    this.defaultLanguage = this.configService.get<string>(
      'DEFAULT_LANGUAGE',
      'fa',
    );

    // preloadLangs omitted → load every language locale-service advertises.
    this.client = createLocaleClient({
      addr,
      scope,
      defaultLang: this.defaultLanguage,
      bootTimeoutMs: 60_000, // survive locale-service still starting up
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
      `locale-service connected: langs=${this.client.languages().join(', ')}, default=${this.defaultLanguage}`,
    );
  }

  onModuleDestroy() {
    this.client.close();
  }

  /** Manual re-sync. The Watch stream already keeps the cache live. */
  async reload(): Promise<void> {
    try {
      await this.client.resync();
      this.logger.log('locales re-synced');
    } catch (e) {
      this.logger.error('re-sync failed, keeping cached data', e as Error);
    }
  }

  /** Nested namespace tree (dot-notation keys re-expanded), or undefined. */
  getNamespace(lang: string, namespace: string): Namespace | undefined {
    const flat = this.client.namespace(lang, namespace);
    if (!flat) return undefined;
    return unflatten(flat);
  }

  /** Single value by flat (dot-notation) key, or undefined. */
  getKey(lang: string, namespace: string, key: string): any {
    return this.client.namespace(lang, namespace)?.[key];
  }

  /** Whole cache as nested trees: data[lang][namespace] = tree. */
  getAll(): LocaleData {
    const out: LocaleData = {};
    for (const lang of this.client.languages()) {
      const snap = this.client.cached(lang);
      if (!snap) continue;
      out[lang] = {};
      for (const [ns, data] of Object.entries(snap.namespaces)) {
        out[lang][ns] = unflatten(data.entries);
      }
    }
    return out;
  }

  getAvailableLanguages(): string[] {
    return this.client.languages();
  }

  getDefaultLanguage(): string {
    return this.defaultLanguage;
  }

  resolveLanguage(acceptLanguage?: string): string {
    return this.client.resolveLanguage(acceptLanguage);
  }
}

/** {"a.b": "x"} -> {a: {b: "x"}} */
function unflatten(flat: Record<string, string>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [path, value] of Object.entries(flat)) {
    const parts = path.split('.');
    let node = out;
    for (let i = 0; i < parts.length - 1; i++) {
      node[parts[i]] ??= {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = value;
  }
  return out;
}
