import { Inject, Injectable } from '@nestjs/common';
import { ItemTextWriter, TRANSLATOR, type ItemTextStore, type Translator } from '@txnet-backend/shared-core';

import { TenantPackageRefused } from './tenant-package.refusal';

/**
 * A package's name and description in every language (ADR-0154 decision 5):
 * shared-core's `ItemTextWriter` over the `packages` namespace. The key is
 * derived here from the package id and never taken from a caller; the `name`
 * column stays the source-language text, so refusals and logs keep reading it
 * and a package whose text was never written still has a name.
 */

export const PACKAGE_TEXT_NAMESPACE = 'packages';
export type PackageTextField = 'name' | 'description';

export const PACKAGE_TEXT_STORE = Symbol('PACKAGE_TEXT_STORE');

const KEY_RE = /^packages\.p_([0-9a-f]{32})\.(name|description)$/;

const uuidOf = (h: string) => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;

/** The i18n key of a package's text: `packages.p_<id, no dashes>.<field>`. */
export function packageTextKey(packageId: string, field: PackageTextField): string {
  return `${PACKAGE_TEXT_NAMESPACE}.p_${packageId.replace(/-/g, '').toLowerCase()}.${field}`;
}

/** The package a key `packageTextKey` built is for, or `null` for any other key. */
export function packageOfTextKey(key: string): string | null {
  const m = KEY_RE.exec(key);
  return m ? uuidOf(m[1]) : null;
}

/** What a package view says about its text; the panel resolves the keys in its reader's language. */
export type PackageTextView = { sourceLang: string; nameKey: string; descriptionKey: string | null };

@Injectable()
export class PackageTextService extends ItemTextWriter {
  constructor(
    @Inject(PACKAGE_TEXT_STORE) private readonly locale: ItemTextStore,
    @Inject(TRANSLATOR) translator: Translator,
  ) {
    super(locale, translator, {
      namespace: PACKAGE_TEXT_NAMESPACE,
      keyPattern: KEY_RE,
      refuse: (reason, detail) => new TenantPackageRefused(reason, detail),
    });
  }

  /** The source language a write settles on: the one asked for, else `DEFAULT_LANGUAGE`; one locale-service lacks is `lang_unknown`. */
  sourceOf(requested: string | null | undefined): string {
    const lang = requested ?? this.defaultLanguage();
    if (!this.languages().includes(lang)) throw new TenantPackageRefused('lang_unknown', lang);
    return lang;
  }

  /** The keys of a package's text; `descriptionKey` only when a description is published in its source language. */
  viewOf(packageId: string, sourceLang: string | null): PackageTextView {
    const lang = sourceLang ?? this.defaultLanguage();
    const descriptionKey = packageTextKey(packageId, 'description');
    return { sourceLang: lang, nameKey: packageTextKey(packageId, 'name'), descriptionKey: this.published(lang, descriptionKey) ? descriptionKey : null };
  }

  /** Whether a package's name is published in its source language — a package from before PK-1-c has none. */
  hasSourceName(packageId: string, sourceLang: string): boolean {
    return this.published(sourceLang, packageTextKey(packageId, 'name')) !== undefined;
  }

  // locale-service holds an entry without its namespace.
  private published(lang: string, key: string): string | undefined {
    return this.locale.namespace(lang, PACKAGE_TEXT_NAMESPACE)?.[key.slice(PACKAGE_TEXT_NAMESPACE.length + 1)];
  }
}
