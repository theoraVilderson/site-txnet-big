"use client";

import { CatalogView } from "../../catalog/_components/CatalogView";
import { ResellerCatalogView } from "../../my-resellers/[id]/catalog/_components/ResellerCatalogView";
import { SelfWorkspace } from "../_components/SelfWorkspace";

/** `/reseller/catalog` on a reseller's own domain (F-061-n): its catalog, as `/my-resellers/:id/catalog`. */
export default function Page() {
  return (
    <SelfWorkspace>
      {(id) => (
        <ResellerCatalogView id={id}>
          <CatalogView />
        </ResellerCatalogView>
      )}
    </SelfWorkspace>
  );
}
