import { TranslationsView } from "../_components/TranslationsView";

/**
 * `/catalog/translations` — review of machine-drafted catalog names
 * (F-1533-e, ADR-0050). A server shell around one client view, like `/catalog`.
 * Which drafts appear is billing's answer for the caller's tenant.
 */
export default function CatalogTranslationsPage() {
  return <TranslationsView />;
}
