/** Persian (۰-۹) and Arabic-Indic (٠-٩) digits to ASCII; everything else as it was. */
export const toEnglishDigits = (str: string) => {
  if (!str) return "";
  return str
    .replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d).toString())
    .replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d).toString());
};

/**
 * The panel's translator — `useLocale().t` from `@/context/LocaleContext`.
 * Typed here rather than imported so this module stays free of React.
 */
export type Translate = (
  ns: string,
  key: string,
  vars?: Record<string, string | number>,
) => string;

export function isValidJsonObject(
  value: unknown,
): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}
