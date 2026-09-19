import { CNAME_TARGET_ZONE } from '@txnet-backend/shared-core';

import type { ProbeAnswer } from './domain-lookup';

/**
 * What a custom domain is checked against, and how each answer is judged
 * (F-018-i, catalog 13.2). Pure: the lookups are the service's, so every rule
 * here is asserted without DNS or a network.
 */

/**
 * The label the TXT record lives under. Neutral on purpose: a reseller's DNS
 * zone is public, and a label naming the platform would be a trace of it
 * (catalog 13.4, F-108).
 */
export const VERIFY_RECORD_LABEL = '_domain-verification';

/** The public path the http and https checks request, served by `DomainProbeController`. */
export const PROBE_PATH = 'tenant-domain-probe';

export const verifyRecordName = (host: string): string => `${VERIFY_RECORD_LABEL}.${host}`;

export type CheckName = 'txt' | 'cname' | 'http' | 'https';

/** One line of a check: what was expected, what was found, and whether they agree. */
export type CheckLine = { check: CheckName; expected: string[]; found: string[]; ok: boolean };

/** A whole check, as stored in `tenant_domain.lastCheck` and shown to the tenant. */
export type DomainCheck = { at: string; ok: boolean; lines: CheckLine[] };

/** The record holds the token among whatever else the name carries. */
export function txtLine(host: string, token: string, found: string[]): CheckLine {
  return { check: 'txt', expected: [`${verifyRecordName(host)} TXT ${token}`], found, ok: found.includes(token) };
}

/**
 * The CNAME must not name **another** reseller's target. It is not required to
 * name this one's: a CDN in front of the domain answers DNS with its own name,
 * and the target is then its origin, visible only in the host a request
 * arrives as — which the probe lines judge. A CNAME to someone else's target
 * is the one DNS answer that is wrong on its face.
 */
export function cnameLine(target: string, domain: string, found: string[]): CheckLine {
  const zone = `.${CNAME_TARGET_ZONE}.${domain}`.toLowerCase();
  const names = found.map((n) => n.toLowerCase().replace(/\.+$/, ''));
  return { check: 'cname', expected: [target], found: names, ok: !names.some((n) => n.endsWith(zone) && n !== target) };
}

/**
 * The request reached the platform — our answer, with the nonce this check
 * sent, so no cached or look-alike page passes — and arrived as the domain
 * itself or as the reseller's own target. Arriving as another reseller's
 * target would serve that reseller's panel on this domain.
 */
export function probeLine(
  scheme: 'http' | 'https',
  host: string,
  target: string,
  nonce: string,
  answer: ProbeAnswer,
): CheckLine {
  // As the domain only (ADR-0063): the target serves nothing, so a CDN that
  // forwards it instead of the visitor's host would break every page. `target`
  // stays in the signature so the refusal can name what the CDN must change.
  const expected = [`200 as ${host} (not ${target} — keep the visitor's host at the CDN)`];
  if ('error' in answer) return { check: scheme, expected, found: [answer.error], ok: false };
  const data = envelopeData(answer.body);
  if (answer.status !== 200 || !data || data['nonce'] !== nonce) {
    return { check: scheme, expected, found: [String(answer.status)], ok: false };
  }
  const as = String(data['host']);
  return { check: scheme, expected, found: [`200 as ${as}`], ok: as === host };
}

function envelopeData(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== 'object') return null;
  const { ok, data } = body as { ok?: unknown; data?: unknown };
  return ok === true && data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
}
