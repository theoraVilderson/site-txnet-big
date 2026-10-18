import { ApiError } from "@/lib/api-error";
import type { CreatePackageBody, ResellerLimitKey, ResellerLimitRow } from "@/lib/tenant-api";
import type { Errors } from "./resellers";
import { limitValueOf, productQuotaBodyOf } from "./limits";
import { PACKAGE_KEYS, WHOLESALE_METERS, createPackageBody, emptyPackageForm, validatePackage, type PackageForm } from "./packages";

/**
 * The new-package wizard (PK-1-g, ADR-0154 (3)(4)): its steps, what each asks
 * and checks, and the one `POST /tenant-packages` it ends in. Edit is never the
 * wizard — it is the package's page (PK-1-f).
 */

const K = PACKAGE_KEYS.wizard;

/** ADR-0154 (3)'s order: name and description → prices → features → products → limits → wholesale rates → review. */
export const PACKAGE_WIZARD_STEPS = ["names", "prices", "features", "products", "limits", "rates", "review"] as const;
export type PackageWizardStep = (typeof PACKAGE_WIZARD_STEPS)[number];

/** A ticked product's sales cap per fixed window as typed; blank is no bound there (F-019-v6). */
export type ProductWindows = { day: string; week: string; month: string };
/** A limit the owner changed: a typed number, or "no limit" ticked. */
export type LimitChoice = { typed: string; noLimit: boolean };

export interface PackageWizardForm extends PackageForm {
  sourceLang: string;
  description: string;
  /** The products it sells, by id — a product is ticked when it has an entry. */
  products: Record<string, ProductWindows>;
  /** Only the keys the owner changed; every other key keeps the platform's value and is not sent. */
  limits: Partial<Record<ResellerLimitKey, LimitChoice>>;
}

/** What the limits step needs of `GET /tenants/limits/settings`'s row to check a value. */
type LimitBound = Pick<ResellerLimitRow, "key" | "max">;
/** What the products step needs of a catalog product to offer it. */
type ProductRow = { id: string; platform: boolean; isActive: boolean; archivedAt: string | null };

/** tenant-package.schema.ts's bound on a description. */
export const DESCRIPTION_MAX = 2000;
const NO_WINDOW: ProductWindows = { day: "", week: "", month: "" };

/** A platform product a new package may list: the platform's own, on sale and not archived. */
export const offeredProduct = (p: ProductRow) => p.platform && p.isActive && p.archivedAt === null;

/** The wizard's start: every offered product ticked with no window (ADR-0154 (3)), no limit changed. */
export function emptyPackageWizard(sourceLang: string, products: readonly ProductRow[]): PackageWizardForm {
  return {
    ...emptyPackageForm(),
    sourceLang,
    description: "",
    products: Object.fromEntries(products.filter(offeredProduct).map((p) => [p.id, { ...NO_WINDOW }])),
    limits: {},
  };
}

/** The wizard as the owner left it: `products` is `null` until they tick or untick one — every offered product, whatever has loaded. */
export type PackageWizardDraft = Omit<PackageWizardForm, "products"> & { products: PackageWizardForm["products"] | null };

/** A draft with nothing in it yet, its text in `sourceLang`. */
export const emptyPackageDraft = (sourceLang: string): PackageWizardDraft => ({ ...emptyPackageWizard(sourceLang, []), products: null });

/** The form a draft stands for once `products` are read: untouched products are the default, every offered one. */
export function formOfDraft(draft: PackageWizardDraft, products: readonly ProductRow[]): PackageWizardForm {
  return { ...draft, products: draft.products ?? emptyPackageWizard(draft.sourceLang, products).products };
}

/** A ticked product's terms as its route takes them — `stop` past the cap; `undefined` when a window is not a number. */
const productTerms = (windows: ProductWindows) => productQuotaBodyOf({ ...windows, mode: "stop", price: "" });

const limitValue = (choice: LimitChoice, bound: LimitBound | undefined) =>
  bound ? limitValueOf(choice.typed, choice.noLimit, bound.max) : undefined;

const boundOf = (limits: readonly LimitBound[], key: string) => limits.find((l) => l.key === key);

/** `validatePackage`'s answer for the fields `fields` names. */
function packageErrors(form: PackageForm, fields: readonly (keyof PackageForm)[]): Record<string, string> {
  return Object.fromEntries(Object.entries(validatePackage(form) as Errors<PackageForm>).filter(([f]) => fields.includes(f as keyof PackageForm))) as Record<
    string,
    string
  >;
}

/** What blocks Next on `step`, by field — `products.<id>` and `limits.<key>` for one row of those steps. */
export function packageWizardErrors(step: PackageWizardStep, form: PackageWizardForm, limits: readonly LimitBound[]): Record<string, string> {
  switch (step) {
    case "names": {
      const errors = packageErrors(form, ["name"]);
      if (form.description.trim().length > DESCRIPTION_MAX) errors.description = K.errors.description;
      return errors;
    }
    case "prices":
      return packageErrors(form, ["monthlyPrice", "yearlyPrice"]);
    case "features":
      return {};
    case "products":
      return Object.fromEntries(
        Object.entries(form.products)
          .filter(([, windows]) => productTerms(windows) === undefined)
          .map(([id]) => [`products.${id}`, K.errors.window]),
      );
    case "limits":
      return Object.fromEntries(
        Object.entries(form.limits)
          .filter(([key, choice]) => choice && limitValue(choice, boundOf(limits, key)) === undefined)
          .map(([key]) => [`limits.${key}`, K.errors.limit]),
      );
    case "rates":
      return packageErrors(form, ["rates"]);
    case "review":
      return {};
    default: {
      const unknown: never = step;
      throw new Error(`no checks for step ${String(unknown)}`);
    }
  }
}

/** The first step a form still fails — where "create" sends the owner instead of calling. */
export function firstInvalidStep(form: PackageWizardForm, limits: readonly LimitBound[]): PackageWizardStep | null {
  return PACKAGE_WIZARD_STEPS.find((s) => Object.keys(packageWizardErrors(s, form, limits)).length > 0) ?? null;
}

/** The whole package as one `POST /tenant-packages` body (ADR-0154 (4)); call after {@link firstInvalidStep} answers `null`. */
export function packageWizardBody(form: PackageWizardForm, limits: readonly LimitBound[]): CreatePackageBody {
  const description = form.description.trim();
  const products = Object.entries(form.products).flatMap(([productId, windows]) => {
    const terms = productTerms(windows);
    return terms ? [{ productId, ...terms }] : [];
  });
  const changed = Object.entries(form.limits).flatMap(([key, choice]) => {
    const value = choice ? limitValue(choice, boundOf(limits, key)) : undefined;
    return value === undefined ? [] : [{ key: key as ResellerLimitKey, value }];
  });
  return {
    ...createPackageBody(form),
    sourceLang: form.sourceLang,
    ...(description ? { description } : {}),
    ...(products.length > 0 ? { products } : {}),
    ...(changed.length > 0 ? { limits: changed } : {}),
  };
}

/** The step that asks each body field (the first segment of a `fieldErrors` path, PK-1-j). */
const FIELD_STEP: Record<string, PackageWizardStep> = {
  name: "names",
  sourceLang: "names",
  description: "names",
  monthlyPrice: "prices",
  yearlyPrice: "prices",
  includedFeatureKeys: "features",
  products: "products",
  limits: "limits",
  quotaOverages: "limits",
  meterRates: "rates",
};

/** The step a refusal with no field belongs to (`tenant/contract.admin.md` "Packages"). */
const REASON_STEP: Record<string, PackageWizardStep> = {
  package_name_taken: "names",
  lang_unknown: "names",
  package_unpriced: "prices",
  package_price_finer_than_currency: "prices",
  product_not_found: "products",
  unknown_limit: "limits",
  limit_out_of_range: "limits",
  not_a_quota: "limits",
  meter_not_found: "rates",
};

/** Where a refused create returns the owner: the step of the field it names, else of its reason; `null` stays on the review. */
export function refusalStep(e: unknown): PackageWizardStep | null {
  if (!(e instanceof ApiError)) return null;
  const field = e.fieldErrors[0]?.path.split(".")[0];
  if (field && FIELD_STEP[field]) return FIELD_STEP[field];
  return (e.reason && REASON_STEP[e.reason]) || null;
}

/** The review's warnings, as locale keys: a package that lists no product, and what each blank wholesale rate stops a reseller selling. */
export function reviewWarnings(form: PackageWizardForm): string[] {
  const blank = WHOLESALE_METERS.filter((m) => form.rates[m.meterKey].trim() === "").map((m) => m.blank);
  return [...(Object.keys(form.products).length === 0 ? [K.sellsNothing] : []), ...blank];
}
