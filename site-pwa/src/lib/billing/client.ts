// Browser calls `/api/billing` on the page's own domain, the same way it calls
// auth-service (ADR-0060) — with the access token as a Bearer header, and
// `forward-auth` turning that into the `X-User-Id` every billing route reads.
// There is no Next.js proxy hop: the panel removed its one on 2026-09-05 and
// lists it under Deprecations (`panel-web/contract.md`), because
// server-to-server was the source of an intermittent 502. Traefik, not this
// app, routes the path to the service.
import { API_BASE } from "../api-origin";
import { createApiClient } from "../api-request";
// Through the facade, not `./auth/…`: a spec that mocks `@/lib/auth-api` reaches this client too (FE-1-h).
import { authApi } from "../auth-api";

const API_URL = `${API_BASE}/billing`;

/**
 * The token is `auth-api`'s, read per call. Billing mints no credential of its
 * own — every route behind the gate is authorised by the same session — so this
 * deliberately has no token state to get out of step with `auth-api`'s.
 */
export const call = createApiClient({
  baseUrl: API_URL,
  service: "billing-service",
  credential: () => authApi.getAccessToken(),
  // Billing is behind the gate, so it is the client most likely to be refused
  // with `permissionsChanged` (ADR-0043). The refresh is auth-api's, shared.
  onCredentialRefused: (stale) => authApi.refreshCredential(stale),
  // A page that fetches on mount (the top-up page's gateways) waits for the
  // page-load session instead of racing it with no token.
  credentialSettled: () => authApi.credentialSettled(),
});

/** One page of either list. The two lists differ only in their row. */
export interface Paged<Row> {
  total: number;
  page: number;
  pageSize: number;
  rows: Row[];
}

/** A keyset page: `next` is the `after` of the following one, null on the last. */
export interface CursorPage<Row> {
  items: Row[];
  next: string | null;
}
