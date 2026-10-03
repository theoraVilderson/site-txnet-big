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
  | 'hours_invalid';

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
