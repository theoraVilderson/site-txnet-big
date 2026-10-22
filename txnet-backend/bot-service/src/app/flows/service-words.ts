import { BotText } from '@txnet-backend/messenger';
import { remainingLabel } from '@txnet-backend/shared-core';
import type { MyService } from '../billing-api/services.types';
import { BotKeys } from '../locale/bot-keys';
import { LocaleService } from '../locale/locale.service';

/**
 * The words a service is told in, shared by My services (F-307-y) and its
 * renewal (F-305-i): its name and its bytes, as every notice says them.
 */

/** A catalog name key is `catalog.<entry>`, served from the `catalog` namespace (as auth-service's notices read it). */
const CATALOG_PREFIX = 'catalog.';

/**
 * As My services and every notice name it (F-307-x): the buyer's own name,
 * else the catalog's in the chat's language (else the default one), else the
 * sku. A name key with no text is never shown as itself.
 */
export function serviceNameOf(s: Pick<MyService, 'label' | 'variant'>, lang: string, locale: LocaleService): BotText {
  if (s.label) return { raw: s.label };
  return planNameOf(s.variant, lang, locale);
}

/** A plan by its catalog name, else its sku, else a plain word. */
export function planNameOf(plan: { sku: string; nameKey: string } | null, lang: string, locale: LocaleService): BotText {
  const catalog = catalogNameOf(plan?.nameKey ?? null, lang, locale);
  if (catalog) return { raw: catalog };
  return plan?.sku ? { raw: plan.sku } : { key: BotKeys.services.unnamed };
}

function catalogNameOf(key: string | null, lang: string, locale: LocaleService): string | undefined {
  if (!key?.startsWith(CATALOG_PREFIX)) return undefined;
  const entry = key.slice(CATALOG_PREFIX.length);
  const text = locale.getKey(lang, 'catalog', entry) ?? locale.getKey(locale.getDefaultLanguage(), 'catalog', entry);
  return typeof text === 'string' && text !== '' ? text : undefined;
}

/** Bytes as the notices say them (`remainingLabel`); nothing reads 0, not its "at least 1 MB". */
export function bytesLabel(bytes: string): string {
  const n = BigInt(bytes);
  return n === BigInt(0) ? '0 MB' : remainingLabel(n);
}
