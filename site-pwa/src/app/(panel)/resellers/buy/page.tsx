import { BuyResellerView } from "./_components/BuyResellerView";

/**
 * `/resellers/buy` — a platform user buys a reseller of their own (F-019-i).
 *
 * A sibling of the platform owner's administration, not part of it: its
 * audience is every user of the platform owner's tenant. **No layout may be
 * added under `(panel)/resellers/` that gates on `canAdministerResellers`** —
 * it would lock this page's visitors out of it (`contract.resellers.md`).
 * Nothing here reads `useSearchParams`, so there is no `Suspense` to wrap.
 */
export default function BuyResellerPage() {
  return <BuyResellerView />;
}
