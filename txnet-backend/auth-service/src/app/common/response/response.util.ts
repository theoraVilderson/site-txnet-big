/**
 * Moved to `shared-core` (F-094): the envelope is a wire shape `bot-service`
 * and the panel read, and a second service answering in a copy of it would
 * drift. This path re-exports it so its importers need no edit; new code
 * imports from `@txnet-backend/shared-core`.
 */
export { err, ok, safeExecute } from '@txnet-backend/shared-core';
export type {
  EnvelopeTranslator,
  ErrorResponse,
  ResponseType,
  SuccessResponse,
} from '@txnet-backend/shared-core';
