import type { OverageView, ResellerLimitKey, ResellerLimitKind, ResellerLimitRow, TenantPackage, UpdatePackageBody } from "@/lib/tenant-api";
import type { Errors } from "./resellers";
import { packageFormOf, updatePackageBody, validatePackage, type PackageForm } from "./packages";

/**
 * What one package's page (`/resellers/packages/[id]`, PK-1-f, ADR-0154 (2))
 * decides: which fields each section's sheet owns, and every registry key as
 * this package holds it beside the platform's.
 */

/** The fields each section's sheet edits; `PATCH /tenant-packages/:id` gets those and no others. */
export const PACKAGE_SECTION_FIELDS = {
  basics: ["name", "monthlyPrice", "yearlyPrice"],
  features: ["featureKeys"],
  rates: ["rates"],
} as const satisfies Record<string, readonly (keyof PackageForm)[]>;
export type PackageSection = keyof typeof PACKAGE_SECTION_FIELDS;

/** `form` with every field outside `section` put back as `p` holds it. */
function onlySection(p: TenantPackage, form: PackageForm, section: PackageSection): PackageForm {
  const kept: PackageForm = packageFormOf(p);
  for (const field of PACKAGE_SECTION_FIELDS[section]) Object.assign(kept, { [field]: form[field] });
  return kept;
}

/** The section's edit as `PATCH`'s body — only its fields that differ, `null` when none does. */
export function sectionBody(p: TenantPackage, form: PackageForm, section: PackageSection): UpdatePackageBody | null {
  return updatePackageBody(p, onlySection(p, form, section));
}

/** {@link validatePackage}'s answer for the fields `section` shows. */
export function sectionErrors(form: PackageForm, section: PackageSection): Errors<PackageForm> {
  const all = validatePackage(form);
  const own: readonly (keyof PackageForm)[] = PACKAGE_SECTION_FIELDS[section];
  return Object.fromEntries(Object.entries(all).filter(([field]) => own.includes(field as keyof PackageForm)));
}

/** One registry key as this package holds it. */
export interface PackageLimit {
  key: ResellerLimitKey;
  kind: ResellerLimitKind;
  max: number;
  /** The package's own row: a number, `null` no limit; `undefined` none — the platform's applies. */
  own: number | null | undefined;
  /** What a package with no row gets: the platform's row, else the code's default; `null` no limit. */
  platform: number | null;
  /** A quota's answer past it — the package's own (`undefined`: the platform's applies) and the platform's (`null`: not set, refused); `null` for a guard. */
  overage: { own: OverageView | undefined; platform: OverageView | null } | null;
}

/** What a package with no row of its own gets for `row`'s key: the platform's row, else the code's default; `null` no limit. */
export const platformValueOf = (row: Pick<ResellerLimitRow, "platform" | "codeDefault">) => (row.platform ? row.platform.value : row.codeDefault);

/** Every key of `GET /tenants/limits/settings` as package `packageId` holds it, in the registry's order. */
export function packageLimitsOf(table: readonly ResellerLimitRow[], packageId: string): PackageLimit[] {
  return table.map((r) => {
    const own = r.packages.find((p) => p.packageId === packageId);
    const past = r.overage?.packages.find((p) => p.packageId === packageId);
    return {
      key: r.key,
      kind: r.kind,
      max: r.max,
      own: own ? own.value : undefined,
      platform: platformValueOf(r),
      overage: r.overage
        ? { own: past ? { mode: past.mode, unitPrice: past.unitPrice, currencyCode: past.currencyCode } : undefined, platform: r.overage.platform }
        : null,
    };
  });
}

/** A package that lists no platform product sells nothing: a reseller sells only what its package lists (ADR-0107 point 3, ADR-0154 (8)). */
export const sellsNothing = (p: Pick<TenantPackage, "productCount">) => p.productCount === 0;
