// tenant-service on its own public paths, `/api/tenants` and `/api/tenant-packages`
// on the page's own domain (ADR-0058, ADR-0060). The access token as a Bearer
// header, exactly as `billing-api.ts` calls billing: the same gate, the same credential.
import { API_BASE } from "./api-origin";
import { createApiClient } from "./api-request";
import { authApi } from "./auth-api";

/** The one caller for tenant-service; `tenant-api.ts` builds every route on it. */
export const call = createApiClient({
  baseUrl: API_BASE,
  service: "tenant-service",
  credential: () => authApi.getAccessToken(),
  onCredentialRefused: (stale) => authApi.refreshCredential(stale),
  credentialSettled: () => authApi.credentialSettled(),
});
