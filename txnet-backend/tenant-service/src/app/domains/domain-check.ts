import { CNAME_TARGET_ZONE, publicPath } from '@txnet-backend/shared-core';

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
export const PROBE_PATH = publicPath('tenant', 'domain-probe');

/** @deprecated since 2026-09-19, remove after the next release: the probe's path before ADR-0065 (F-018-ak). */
export const LEGACY_PROBE_PATH = 'tenant-domain-probe';

export const verifyRecordName = (host: string): string => `${VERIFY_RECORD_LABEL}.${host}`;

export type CheckName = 'txt' | 'cname' | 'http' | 'https' | 'cache' | 'edge_owner';

/**
 * Lines shown with a check that never decide it: the edge's ownership record
 * belongs to the CDN's step after `verified`, not to the domain's own proof.
 */
export const ADVISORY_LINES: ReadonlySet<CheckName> = new Set(['edge_owner']);

/** One line of a check: what was expected, what was found, and whether they agree. */
export type CheckLine = { check: CheckName; expected: string[]; found: string[]; ok: boolean };

/** A whole check, as stored in `tenant_domain.lastCheck` and shown to the tenant. */
export type DomainCheck = { at: string; ok: boolean; lines: CheckLine[] };

/** A check's result as the page shows it, order aside: two equal ones are no news (RT-1-e2). */
export function resultOf(check: unknown): string {
  const lines = (check as DomainCheck | null)?.lines ?? [];
  return JSON.stringify(lines.map((l) => [l.check, l.ok, [...l.found].sort()]).sort());
}

/** The record holds the token among whatever else the name carries. */
export function txtLine(host: string, token: string, found: string[]): CheckLine {
  return { check: 'txt', expected: [`${verifyRecordName(host)} TXT ${token}`], found, ok: found.includes(token) };
}

/**
 * The CNAME must not name **another** reseller's target. It is not required to
 * name this one's: a CDN in front of the domain answers DNS with its own name,
 * and the target is then its origin, visible only in the host a request
 * arrives as — which the probe lines judge. A CNAME to someone else's target
 * is the one DNS answer that is wrong on its face — under either of the
 * platform's domains, so this reseller's target on the other path fails too
 * (NIN-1-e1).
 */
export function cnameLine(target: string, domains: readonly string[], found: string[]): CheckLine {
  const zones = domains.filter(Boolean).map((d) => `.${CNAME_TARGET_ZONE}.${d}`.toLowerCase());
  const names = found.map((n) => n.toLowerCase().replace(/\.+$/, ''));
  return { check: 'cname', expected: [target], found: names, ok: !names.some((n) => zones.some((z) => n.endsWith(z)) && n !== target) };
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

/**
 * A page for one signed-in user must never reach another (ADR-0129 (8)). Two
 * requests to one URL, each with its own nonce in a header the way a session
 * rides in a cookie or a token: a CDN that caches by URL whatever the request
 * carried hands the second one the first one's answer. The probe answers
 * `Cache-Control: private, no-store`, so a CDN that honours it passes.
 */
export function cacheLine(nonces: [string, string], answers: [ProbeAnswer, ProbeAnswer]): CheckLine {
  const expected = ['each request answered on its own — the CDN honours Cache-Control: private, no-store'];
  for (const [i, answer] of answers.entries()) {
    if ('error' in answer) return { check: 'cache', expected, found: [answer.error], ok: false };
    const nonce = envelopeData(answer.body)?.['nonce'];
    if (answer.status !== 200 || typeof nonce !== 'string') return { check: 'cache', expected, found: [String(answer.status)], ok: false };
    if (nonce !== nonces[i]) return { check: 'cache', expected, found: ['cached'], ok: false };
  }
  return { check: 'cache', expected, found: ['each its own'], ok: true };
}

function envelopeData(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== 'object') return null;
  const { ok, data } = body as { ok?: unknown; data?: unknown };
  return ok === true && data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
}

/**
 * The edge's ownership record (EDGE-1-d, ADR-0129 (4)). Behind a reseller's own
 * CDN, DNS answers with the CDN's addresses, so the provider asks for this TXT
 * and answers every request with 409 until it is there. A CNAME straight to the
 * reseller's target proves the hostname by itself, and then no TXT is needed.
 */
export function edgeOwnerLine(record: { name: string; value: string }, target: string, txt: string[], cname: string[]): CheckLine {
  const direct = cname.some((n) => n.toLowerCase().replace(/\.+$/, '') === target);
  return {
    check: 'edge_owner',
    expected: [`${record.name} TXT ${record.value} (behind your own CDN; until it is there the edge answers 409)`],
    found: txt,
    ok: direct || txt.includes(record.value),
  };
}
