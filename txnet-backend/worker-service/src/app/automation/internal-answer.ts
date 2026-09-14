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
