import { CatalogView } from "./_components/CatalogView";

/**
 * `/catalog` — catalog management (F-026-f, D-34).
 *
 * A server shell around one client view, like the coupons page. Which items
 * appear is billing's answer for the caller's tenant, never a filter here.
 */
export default function CatalogPage() {
  return <CatalogView />;
}
