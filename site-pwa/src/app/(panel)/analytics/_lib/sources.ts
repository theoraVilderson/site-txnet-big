import { FrontendI18nKeys } from "@/generated/i18n-keys";

const C = FrontendI18nKeys.common.analytics.customers;

/** The signup sources billing names that have words of their own (F-1001-g); the channel of a cohort too (F-1004-b). */
const SOURCE_KEYS: Readonly<Record<string, string>> = { web: C.sources.web, unknown: C.sources.unknown, telegram: C.sources.telegram, bale: C.sources.bale };

/** A source with words of its own is said in them; any other is a bot platform, named as it is. */
export const sourceNamer =
  (t: (ns: string, key: string) => string) =>
  (source: string): string =>
    SOURCE_KEYS[source] ? t("common", SOURCE_KEYS[source]) : source;
