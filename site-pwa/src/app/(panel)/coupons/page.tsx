import { CouponsView } from "./_components/CouponsView";

/**
 * `/coupons` — coupon and gift-code management (F-502-g/h, D-33).
 *
 * A server shell around one client view, like the gateways page. Which coupons
 * appear is billing's answer for the caller's tenant, never a filter here.
 */
export default function CouponsPage() {
  return <CouponsView />;
}
