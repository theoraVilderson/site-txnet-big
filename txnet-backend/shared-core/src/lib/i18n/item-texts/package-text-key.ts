/**
 * Where a reseller package's name and description live in locale-service
 * (ADR-0154 (5)): tenant-service writes them, and every service that tells a
 * package by name — ai's upgrade suggestion, auth-service's notice (PK-1-e) —
 * reads the same key. Derived from the package id only, never taken from a caller.
 */
export const PACKAGE_TEXT_NAMESPACE = 'packages';
export type PackageTextField = 'name' | 'description';

/** The i18n key of a package's text: `packages.p_<id, no dashes>.<field>`. */
export function packageTextKey(packageId: string, field: PackageTextField): string {
  return `${PACKAGE_TEXT_NAMESPACE}.p_${packageId.replace(/-/g, '').toLowerCase()}.${field}`;
}
