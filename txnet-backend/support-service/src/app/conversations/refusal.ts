/**
 * Why support refused a call, and who is calling — on their own so that
 * `availability/` can refuse without importing the conversation service that
 * depends on it.
 */

export type ConversationRejection =
  | 'not_found'
  | 'closed'
  | 'category_unknown'
  | 'too_many_unfinished'
  // Attachments (F-033-f).
  | 'empty_message'
  | 'too_many_files'
  | 'file_too_large'
  | 'file_rejected'
  | 'file_infected'
  | 'scan_unavailable'
  | 'quota_exceeded'
  // The agent side (F-033-d).
  | 'assignee_unknown'
  // Working hours (F-033-g).
  | 'hours_invalid'
  // SLA targets (F-033-h).
  | 'sla_invalid'
  // Canned replies (F-033-j).
  | 'canned_unknown'
  | 'canned_key_taken'
  | 'canned_invalid'
  // Auto-close, rating, reopen (F-033-k).
  | 'not_finished'
  | 'already_rated'
  | 'not_closed'
  | 'reopen_expired'
  | 'lifecycle_invalid'
  // Platform staff in a reseller's support (F-033-l).
  | 'not_platform_staff'
  | 'reseller_not_found'
  | 'consent_required'
  | 'consent_read_only';

export class ConversationRefused extends Error {
  constructor(readonly reason: ConversationRejection) {
    super(`support conversation refused: ${reason}`);
    this.name = 'ConversationRefused';
  }
}

export interface SupportCaller {
  tenantId: string;
  userId: string;
}
