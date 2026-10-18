import type { PackagePartRejection } from './package-parts';

/**
 * Why a package write was refused. Its own module because both the service and
 * the writers it calls (`package-parts.ts`, `package-texts.ts`) raise it, and a
 * value import between those would be a cycle.
 *
 * `package_price_finer_than_currency`: a price with more places than the
 * platform's currency has (F-116-r). `lang_unknown`, `text_key_invalid`,
 * `texts_unavailable`: the package's name and description in locale-service
 * (ADR-0154 decision 5).
 */
export type TenantPackageRejection =
  | 'not_platform_owner'
  | 'package_not_found'
  | 'package_name_taken'
  | 'package_unpriced'
  | 'package_price_finer_than_currency'
  | 'package_price_in_use'
  | 'meter_not_found'
  | 'lang_unknown'
  // ItemTextRefusal, spelled out: the panel's test reads this union for a sentence per reason.
  | 'text_key_invalid'
  | 'texts_unavailable'
  | PackagePartRejection;

/** `field`: the request field refused, `limits.2.value`, when a create's part is (ADR-0154 decision 4). */
export class TenantPackageRefused extends Error {
  constructor(
    readonly reason: TenantPackageRejection,
    detail = '',
    readonly field?: string,
  ) {
    super(`tenant package refused: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'TenantPackageRefused';
  }
}
