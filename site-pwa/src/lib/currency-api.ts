// currency-service is served on the page's own domain at `/api/currency`
// (ADR-0100), behind the same gate as billing: the access token as a Bearer
// header, exactly as `billing-api.ts` calls billing.
import { API_BASE } from "./api-origin";
import { createApiClient } from "./api-request";
import { authApi } from "./auth-api";

const call = createApiClient({
  baseUrl: `${API_BASE}/currency`,
  service: "currency-service",
  credential: () => authApi.getAccessToken(),
  onCredentialRefused: (stale) => authApi.refreshCredential(stale),
  credentialSettled: () => authApi.credentialSettled(),
});

/** One active currency and the rate the caller's own books price it at (`GET /rates`, F-116-k). */
export interface CurrencyRate {
  code: string;
  name: string;
  symbol: string;
  decimalPlaces: number;
  isBase: boolean;
  /** Units per one USD, a decimal string (C-02); `null` with no rate. */
  rate: string | null;
  effectiveAt: string | null;
  /** `expiresAt` null: pinned with no end (F-116-n). */
  pinned: { reason: string; expiresAt: string | null } | null;
}

/** A manual rate (`currency/contract.md` "HTTP API", F-0608-a). */
export interface CurrencyPin {
  id: string;
  code: string;
  rate: string;
  reason: string;
  setById: string;
  effectiveAt: string;
  /** `null`: no end, live until a person ends it (F-116-n). */
  expiresAt: string | null;
  endedAt: string | null;
}

/** What the pin form shows for one currency (ADR-0101 part 4). */
export interface CurrencyPinForm {
  code: string;
  /** The caller's own live pin: the platform's, or the tenant's. */
  current: CurrencyPin | null;
  /** For a tenant, the platform's live pin, which answers where it has none. */
  platformPin: CurrencyPin | null;
  lastAccepted: { snapshotId: string; rate: string; effectiveAt: string } | null;
  /** The worker's latest reading, accepted or not — a suggestion, never a rate (D-53). */
  lastDownload: {
    rate: string | null;
    at: string;
    outcome: "accepted" | "refused" | "unavailable";
    used: number;
    sources: number;
    reason: string | null;
  } | null;
}

export interface PinBody {
  code: string;
  rate: string;
  reason: string;
  /** 1..720, or `null` for no end (F-116-n). */
  hours: number | null;
}

export const currencyApi = {
  rates(): Promise<CurrencyRate[]> {
    return call<CurrencyRate[]>("/rates", { method: "GET" });
  },
  pinForm(code: string): Promise<CurrencyPinForm> {
    return call<CurrencyPinForm>(`/pins/${encodeURIComponent(code)}`, { method: "GET" });
  },
  pin(body: PinBody): Promise<CurrencyPin> {
    return call<CurrencyPin>("/pins", { method: "POST", body: JSON.stringify(body) });
  },
  endPin(id: string): Promise<CurrencyPin> {
    return call<CurrencyPin>(`/pins/${encodeURIComponent(id)}/end`, { method: "POST" });
  },
};
