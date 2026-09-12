// Browser calls api.${DOMAIN_NAME}/api/billing directly, the same way it calls
// auth-service — cross-origin, with the access token as a Bearer header, and
// `forward-auth` turning that into the `X-User-Id` every billing route reads.
// There is no Next.js proxy hop: the panel removed its one on 2026-09-05 and
// lists it under Deprecations (`panel-web/contract.md`), because
// server-to-server was the source of an intermittent 502. `billing-service`'s
// `main.ts` had assumed the opposite and shipped with CORS off; F-093-c is the
// first call from this app and the decision was settled with the user then.
import { createApiClient } from "./api-request";
import { authApi } from "./auth-api";

const API_URL = `${process.env.NEXT_PUBLIC_API_ORIGIN}/api/billing`;

/**
 * The token is `auth-api`'s, read per call. Billing mints no credential of its
 * own — every route behind the gate is authorised by the same session — so this
 * deliberately has no token state to get out of step with `auth-api`'s.
 */
const call = createApiClient({
  baseUrl: API_URL,
  service: "billing-service",
  credential: () => authApi.getAccessToken(),
});

/**
 * What `GET /wallet/history` answers, narrowed to the part this app reads today.
 * The route answers `total`, `page`, `pageSize` and `rows[]` beside it
 * (`billing/contract.history.md`); F-093-d is the row that needs those.
 */
export interface WalletBalance {
  /**
   * `wallet.cachedBalance` as a decimal string, in the **base** currency
   * (ADR-0019: USD, two places). Written only inside the transaction that
   * appends the proving ledger row, so it is a balance and not a running total —
   * nothing on this side adds to it or recomputes it.
   */
  balance: string;
}

export const billingApi = {
  /**
   * The wallet's balance, and nothing else.
   *
   * It reads `wallet/history` with the smallest page rather than a route of its
   * own: `{balance}` is already the first field that route answers, and a
   * `GET /wallet/balance` would be a second endpoint returning a value the
   * first one has — a field added because a caller was convenient, which is
   * what §11 forbids. When F-093-d asks for the ledger it widens this method's
   * query; until then one row is the cheapest honest ask.
   *
   * A user with no wallet yet is `"0.00"` and not a 404, so there is no
   * first-top-up special case to write here.
   */
  async walletBalance(): Promise<WalletBalance> {
    return call<WalletBalance>("/wallet/history?page=1&pageSize=1", { method: "GET" });
  },
};
