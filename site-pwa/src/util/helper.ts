import { ZodError } from "zod";

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

/** The namespace every validation string is authored in (`locales/frontend`). */
export const VALIDATIONS_NS = "validations";

/** Shown when the argument is not a ZodError at all. */
export const UNKNOWN_VALIDATION_KEY = "unknown";

interface ZodFormatOptions {
  /**
   * Prefix each message with the field path, e.g. `username: <message>`.
   * @default true
   */
  withPath?: boolean;

  /**
   * Separator between messages.
   * @default "\n"
   */
  separator?: string;

  /**
   * Translator for the active locale. Omitted -> every string comes back as
   * its raw `validations` key, which is exactly what `useLocale().t` does on a
   * miss and what the bot's renderer does with an untranslated key: a visible
   * key, never a sentence in one fixed language.
   */
  t?: Translate;
}

/**
 * Render a `ZodError` as one string in the user's language.
 *
 * Issue messages are looked up in the `validations` namespace, so a schema
 * authored as `z.string().min(3, "fields.username.tooShort")` speaks whatever
 * locale is active. A message that is not a key survives unchanged — `t`
 * returns the key it was given when it finds nothing — so this is safe to put
 * in front of a schema that has not been keyed yet.
 *
 * **The key here is whatever a schema put in `.message`, so no generated
 * constant can check it** (F-084). No shipped schema is keyed today, and F-083
 * deleted the fifteen `validations` keys nothing reached. The first schema
 * that is keyed should author its messages from `FrontendI18nKeys.validations`
 * rather than as literals — that is the whole of the check available here.
 */
export const zodErrorToString = (
  error: ZodError,
  options: ZodFormatOptions = {},
): string => {
  const { withPath = true, separator = "\n", t = (_ns, key) => key } = options;

  if (!error || !error.issues) {
    return t(VALIDATIONS_NS, UNKNOWN_VALIDATION_KEY);
  }

  return error.issues
    .map((issue) => {
      const message = t(VALIDATIONS_NS, issue.message);

      if (withPath && issue.path.length > 0) {
        return `${issue.path.join(".")}: ${message}`;
      }

      return message;
    })
    .join(separator);
};

export function isValidJsonObject(
  value: unknown,
): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}
