/**
 * The acceptance questionnaire as the capability matrix reads it (F-027-as).
 *
 * `network-service` answers these rows into `network.panel.capabilities`
 * (`driver/questionnaire.go`); this is the reading side. The strings cross a
 * process boundary with no import joining them, so their declared home is
 * `contracts/network/capabilities.json`, and `systems-read.spec.ts` holds this
 * copy to it as `questionnaire_test.go` holds the Go one (ADR-0036, C-04).
 *
 * The question and the cost of a `no` are not copied: the page says them in
 * the reader's language, keyed by `key`.
 */
export const CAPABILITIES_VERSION = 1;

export const CAPABILITY_ROWS = [
  { key: 'per_client_usage', scope: 'any', severity: 'required' },
  { key: 'bulk_usage_in_one_call', scope: 'pull', severity: 'required' },
  { key: 'usage_for_named_subset', scope: 'pull', severity: 'degrades' },
  { key: 'usage_reset_supported', scope: 'any', severity: 'degrades' },
  { key: 'counter_survives_client_update', scope: 'any', severity: 'degrades' },
  { key: 'gigawords_reported', scope: 'push', severity: 'degrades' },
  { key: 'per_client_data_limit', scope: 'any', severity: 'metered' },
  { key: 'data_limit_counts_the_same_bytes_as_usage', scope: 'any', severity: 'metered' },
  { key: 'per_client_rate_limit', scope: 'any', severity: 'degrades' },
  { key: 'per_client_ip_limit', scope: 'any', severity: 'degrades' },
  { key: 'enable_disable_client', scope: 'any', severity: 'required' },
  { key: 'client_lifecycle', scope: 'any', severity: 'required' },
  { key: 'stable_remote_id', scope: 'any', severity: 'degrades' },
  { key: 'client_label_storable', scope: 'any', severity: 'degrades' },
  { key: 'native_subscription_link', scope: 'any', severity: 'degrades' },
  { key: 'server_side_expiry', scope: 'any', severity: 'degrades' },
  { key: 'internal_credit_disablable', scope: 'any', severity: 'degrades' },
] as const;

export type CapabilityKey = (typeof CAPABILITY_ROWS)[number]['key'];

/**
 * One row as the page shows it. `not_asked`: outside the panel's transport, so
 * no answer is expected (`Scope.Includes`). `unanswered`: in scope, but no
 * current document answers it — never tested, or tested under another version,
 * which a connection test re-answers rather than anyone migrating.
 */
export type CapabilityState = 'supported' | 'unsupported' | 'unanswered' | 'not_asked';

type Answer = { supported: boolean; detail?: string };

/** The stored document, if it is one this reader was written against; else null. */
function currentAnswers(doc: unknown): Record<string, Answer> | null {
  if (!doc || typeof doc !== 'object') return null;
  const { version, answers } = doc as { version?: unknown; answers?: unknown };
  if (version !== CAPABILITIES_VERSION || !answers || typeof answers !== 'object') return null;
  return answers as Record<string, Answer>;
}

/** Every row of the questionnaire, in its order, for a panel on `transport`. */
export function capabilityMatrix(doc: unknown, transport: string) {
  const answers = currentAnswers(doc);
  const version = doc && typeof doc === 'object' ? ((doc as { version?: unknown }).version ?? null) : null;
  const answeredAt = answers ? ((doc as { answeredAt?: string }).answeredAt ?? null) : null;

  const rows = CAPABILITY_ROWS.map(({ key, scope, severity }) => {
    const base = { key, scope, severity };
    if (scope !== 'any' && scope !== transport) return { ...base, state: 'not_asked' as CapabilityState, detail: null };
    const answer = answers?.[key];
    if (!answer || typeof answer.supported !== 'boolean') return { ...base, state: 'unanswered' as CapabilityState, detail: null };
    return { ...base, state: (answer.supported ? 'supported' : 'unsupported') as CapabilityState, detail: answer.detail ?? null };
  });

  return { documentVersion: typeof version === 'number' ? version : null, current: answers !== null, answeredAt, rows };
}
