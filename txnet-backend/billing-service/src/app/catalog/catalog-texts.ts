import { Inject, Injectable } from '@nestjs/common';
import { ItemTextWriter, TRANSLATOR, type ItemTextStore, type Translator } from '@txnet-backend/shared-core';

import { CatalogAdminRefused } from './catalog-admin.service';

/**
 * Catalog names and descriptions in every language (F-1533-d/f; ADR-0050 and
 * its amendments of 2026-09-16). Writing, drafting and review are shared-core's
 * `ItemTextWriter` (ADR-0154 decision 6); what is the catalog's own is here —
 * the `catalog` namespace and the shape of its keys. A reader falls back from
 * the requested language to the item's source language.
 *
 * **The key is the server's** (the user's call, 2026-09-16): a product key is
 * unique only inside a tenant, so a tenant's text sits under `t_<tenant>.` and
 * the platform's has no prefix. Nobody writes a key they did not derive here.
 */

export const CATALOG_NAMESPACE = 'catalog';
/** `capability` (F-114-f-a, ADR-0086): its key is a dotted feature key, `vpn.access`. */
export type CatalogTextKind = 'category' | 'product' | 'capability';
export type CatalogTextField = 'name' | 'description';
/** The catalog's name for shared-core's store port; its suite builds one. */
export type CatalogTextStore = ItemTextStore;

export const CATALOG_TEXT_STORE = Symbol('CATALOG_TEXT_STORE');

const KEY_RE = /^catalog\.(?:t_([0-9a-f]{32})\.)?(?:(category|product)\.([a-z][a-z0-9_]{1,63})|(capability)\.([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+))\.(name|description)$/;

const hex = (uuid: string) => uuid.replace(/-/g, '').toLowerCase();
const uuidOf = (h: string) => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;

/** The i18n key of an item's text: `catalog.[t_<tenant>.]<kind>.<key>.<field>`. */
export function catalogTextKey(tenantId: string | null, kind: CatalogTextKind, key: string, field: CatalogTextField): string {
  return `${CATALOG_NAMESPACE}.${tenantId ? `t_${hex(tenantId)}.` : ''}${kind}.${key}.${field}`;
}

/** The parts of a key `catalogTextKey` built, or `null` for anything else. */
export function parseCatalogTextKey(
  full: string,
): { tenantId: string | null; kind: CatalogTextKind; key: string; field: CatalogTextField } | null {
  const m = KEY_RE.exec(full);
  if (!m) return null;
  return { tenantId: m[1] ? uuidOf(m[1]) : null, kind: (m[2] ?? m[4]) as CatalogTextKind, key: m[3] ?? m[5], field: m[6] as CatalogTextField };
}

/** The catalog's item text: shared-core's writer over the `catalog` namespace and its keys (ADR-0154 decision 6). */
@Injectable()
export class CatalogTextService extends ItemTextWriter {
  constructor(@Inject(CATALOG_TEXT_STORE) store: CatalogTextStore, @Inject(TRANSLATOR) translator: Translator) {
    super(store, translator, {
      namespace: CATALOG_NAMESPACE,
      keyPattern: KEY_RE,
      refuse: (reason, detail) => new CatalogAdminRefused(reason, detail),
    });
  }
}
