import type { PaymentProviderRegistry } from '../gateway/payment-provider.registry';
import { chargeOf } from '../manual/manual-transfer';
import type { GatewayOffer } from './deposit-pricing';

/**
 * The currencies a tenant's selectable gateways charge in (F-116-j): what its
 * own manual rate may be pinned for, beside its operating currency. A provider
 * this build does not know is left out, as the list and the quote leave it out;
 * a manual gateway counts its destination's (F-803-d).
 */
export function chargeCurrenciesOf(
  gateways: readonly Pick<GatewayOffer, 'providerName' | 'manualSetting'>[],
  providers: Pick<PaymentProviderRegistry, 'has' | 'get'>,
): string[] {
  const codes = gateways.filter((g) => providers.has(g.providerName)).map((g) => chargeOf(g, providers.get(g.providerName)).currency);
  return [...new Set(codes)].sort();
}
