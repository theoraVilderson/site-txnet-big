import { CatalogView } from "../../../catalog/_components/CatalogView";
import { ResellerCatalogView } from "./_components/ResellerCatalogView";

/**
 * `/my-resellers/[id]/catalog` — a reseller's own products, plans and prices
 * (F-066-w8, ADR-0064 (4)), where the onboarding console's pricing step is
 * done. The ambient `/catalog` page's own component over the route that names
 * the reseller (F-066-w7). Anyone signed in may open it; billing admits by the
 * path's reseller (invariant 21) and the page shows its refusal otherwise.
 */
export default async function ResellerCatalogPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <ResellerCatalogView id={id}>
      <CatalogView />
    </ResellerCatalogView>
  );
}
