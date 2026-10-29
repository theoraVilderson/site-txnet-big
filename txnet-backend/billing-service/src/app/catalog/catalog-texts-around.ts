import type { Logger } from '@nestjs/common';
import type { ItemTexts } from '@txnet-backend/shared-core';

import { catalogTextKey, type CatalogTextService } from './catalog-texts';

/** What one catalog write does to its texts: the sources it publishes, the keys it stops naming. */
export type TextPlan = { publish: { key: string; text: ItemTexts }[]; clear: string[] };

/**
 * A catalog write's texts around its transaction (C-29, LIVE-1-j): the
 * sources are published before it opens — locale-service down refuses the
 * write with nothing written, and its latency never holds a pool connection
 * against the 5 s clock — and the keys the write stops naming are cleared
 * after it commits, best effort: a key no row names is never shown.
 */
export async function aroundTexts<T>(texts: CatalogTextService, plan: TextPlan, logger: Logger, write: () => Promise<T>): Promise<T> {
  if (plan.publish.length > 0) await texts.publishSources(plan.publish);
  const done = await write();
  if (plan.clear.length > 0) await texts.clear(plan.clear).catch((e: unknown) => logger.warn(`catalog texts kept: ${String(e)}`));
  return done;
}

/** Whether the tenant already holds `key`: checked before texts are published over its holder's (LIVE-1-j); the unique index settles a race. */
export async function keyHeld(table: { findFirst(args: { where: { tenantId: string | null; key: string } }): Promise<unknown> }, tenantId: string | null, key: string): Promise<boolean> {
  return (await table.findFirst({ where: { tenantId, key } })) !== null;
}

/** One language-drafting request after a write: the text in its source language, and the languages already written. */
export type DraftRequest = { key: string; from: string; text: string; written: string[] };

/** What to draft for one text: from its source language, into every language not written. */
export const drafts = (key: string, from: string, text: ItemTexts): DraftRequest[] =>
  text[from] ? [{ key, from, text: text[from], written: Object.keys(text) }] : [];

/** A product's or capability's derived keys, the texts a create or patch publishes or clears, and what to draft after. */
export function itemTexts(
  kind: 'product' | 'capability',
  keyOwner: string | null,
  key: string,
  sourceLang: string,
  name: ItemTexts | undefined,
  description: ItemTexts | null | undefined,
) {
  const nameKey = catalogTextKey(keyOwner, kind, key, 'name');
  const descriptionKey = catalogTextKey(keyOwner, kind, key, 'description');
  const publish: { key: string; text: ItemTexts }[] = [];
  const draft: DraftRequest[] = [];
  const clear: string[] = [];
  if (name) {
    publish.push({ key: nameKey, text: name });
    draft.push(...drafts(nameKey, sourceLang, name));
  }
  if (description) {
    publish.push({ key: descriptionKey, text: description });
    draft.push(...drafts(descriptionKey, sourceLang, description));
  } else if (description === null) {
    clear.push(descriptionKey);
  }
  return { nameKey, descriptionKey, publish, draft, clear };
}
