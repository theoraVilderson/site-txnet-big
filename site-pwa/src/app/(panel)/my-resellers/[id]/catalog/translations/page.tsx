import { TranslationsView } from "../../../../catalog/_components/TranslationsView";
import { ResellerCatalogView } from "../_components/ResellerCatalogView";

/**
 * `/my-resellers/[id]/catalog/translations` — review of the machine-drafted
 * names of **this reseller's** items (F-1533-e on the reseller's surface,
 * F-066-w8). The ambient review page's own component over the same route that
 * names the reseller; its "back" goes to the reseller's catalog, not the
 * platform's.
 */
export default async function ResellerCatalogTranslationsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <ResellerCatalogView id={id}>
      <TranslationsView />
    </ResellerCatalogView>
  );
}
