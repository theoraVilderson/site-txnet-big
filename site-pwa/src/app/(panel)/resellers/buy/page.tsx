import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { OwnActOnly } from "../../_components/OwnActOnly";
import { BuyResellerView } from "./_components/BuyResellerView";

/**
 * `/resellers/buy` — a platform user buys a reseller of their own (F-019-i).
 *
 * A sibling of the platform owner's administration, not part of it: its
 * audience is every user of the platform owner's tenant. **No layout may be
 * added under `(panel)/resellers/` that gates on `canAdministerResellers`** —
 * it would lock this page's visitors out of it (`contract.resellers.md`).
 * Nothing here reads `useSearchParams`, so there is no `Suspense` to wrap.
 * Closed while an admin is signed in as the person: the purchase is theirs
 * (`OwnActOnly`, ADR-0146).
 */
export default function BuyResellerPage() {
  return (
    <OwnActOnly why={FrontendI18nKeys.common.impersonation.ownActReseller}>
      <BuyResellerView />
    </OwnActOnly>
  );
}
