import { currentRequestId } from '../logging/request-scope';
import { RequestHeaders } from './headers';

/**
 * The headers every call to another service of this platform carries: the
 * service token (ADR-0011) and, inside a request, its id (H13,
 * `platform/hosting/contract.md`). The one home for them (C-27) — a call
 * that spells the token header itself drops the request id, and
 * `codeshape.py` (`raw-service-call`) fails on it.
 */
export function serviceCallHeaders(serviceToken: string): Record<string, string> {
  const requestId = currentRequestId();
  return {
    [RequestHeaders.serviceToken]: serviceToken,
    ...(requestId ? { [RequestHeaders.requestId]: requestId } : {}),
  };
}
