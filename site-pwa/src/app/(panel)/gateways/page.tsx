import { GatewaysView } from "./_components/GatewaysView";

/**
 * `/gateways` — payment gateway management (F-102-d, D-31).
 *
 * A server shell around one client view, like the top-up page. Nothing here is
 * addressable: a half-filled gateway form holds a merchant id, and a URL is the
 * last place one should end up.
 */
export default function GatewaysPage() {
  return <GatewaysView />;
}
