"use client";

import { TranslationsView } from "../../../catalog/_components/TranslationsView";
import { ResellerCatalogView } from "../../../my-resellers/[id]/catalog/_components/ResellerCatalogView";
import { SelfWorkspace } from "../../_components/SelfWorkspace";

/** `/reseller/catalog/translations` on a reseller's own domain (F-061-n): its catalog's drafted names, as `/my-resellers/:id/catalog/translations`. */
export default function Page() {
  return (
    <SelfWorkspace>
      {(id) => (
        <ResellerCatalogView id={id}>
          <TranslationsView />
        </ResellerCatalogView>
      )}
    </SelfWorkspace>
  );
}
