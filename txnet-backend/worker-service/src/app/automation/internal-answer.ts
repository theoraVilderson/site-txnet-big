import type { ConfigService } from '@nestjs/config';
import { serviceCallHeaders } from '@txnet-backend/shared-core';

/**
 * The payload of an internal route's answer, or `null` when it is not a success
 * envelope.
 *
 * `auth-service` and `billing-service` both answer every route — the internal
 * seam included — through shared-core's `ResponseInterceptor`, so a success is
 * `{ ok: true, msg, data }`. A job that reads its counts off the top level sees
 * none and fails a run that worked (2026-09-14: every `deposit_pending_expiry`
 * run, the moment it was first scheduled). `null` keeps the jobs' own rule: an
 * answer in a shape they do not recognise throws, never reports zero.
 */
export function envelopeData(body: unknown): Record<string, unknown> | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const { ok, data } = body as { ok?: unknown; data?: unknown };
  if (ok !== true || data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  return data as Record<string, unknown>;
}

/** Where a job's internal call goes, and how long it may take. */
export type InternalCall = { baseUrl: string; path: string; serviceToken: string; timeoutMs: number };

/**
 * The auth-service route a sweep job calls (GR-1-c, F-030-a), from the env.
 * The env is checked when the call is made, not at boot, for the reason
 * `deposit-expiry.job.ts` gives: an unset one fails the run, not the worker.
 */
export function authInternalCall(config: ConfigService, path: string): () => InternalCall {
  const baseUrl = config.get<string>('AUTH_API_BASE_URL', '').replace(/\/+$/, '');
  const serviceToken = config.get<string>('SERVICE_AUTH_TOKEN', '');
  const timeoutMs = config.get<number>('AUTH_API_TIMEOUT_MS', 30_000);
  return () => {
    if (!baseUrl) throw new Error('AUTH_API_BASE_URL is not set');
    if (!serviceToken) throw new Error('SERVICE_AUTH_TOKEN is not set');
    return { baseUrl, path, serviceToken, timeoutMs };
  };
}

/**
 * POST an internal route and read the counts it answers with — the whole of a
 * sweep job's call (GR-1-c, F-030-a). A refused call or a count missing from
 * the answer throws: an answer it cannot read fails the run rather than
 * reporting zero (automation invariant #3).
 */
export async function postForCounts<K extends string>(call: InternalCall, names: readonly K[]): Promise<Record<K, number>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), call.timeoutMs);
  try {
    const response = await fetch(`${call.baseUrl}${call.path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...serviceCallHeaders(call.serviceToken) },
      body: '{}',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`answered ${response.status} to ${call.path}`);
    const body = envelopeData(await response.json());
    const counts = names.map((k) => [k, body?.[k]] as const);
    if (!counts.every(([, v]) => typeof v === 'number')) throw new Error(`answered ${call.path} without its counts (${names.join(', ')})`);
    return Object.fromEntries(counts) as Record<K, number>;
  } finally {
    clearTimeout(timer);
  }
}
