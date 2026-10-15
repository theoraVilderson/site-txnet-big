import { PanelReviewState, Prisma } from '@prisma/client';

/**
 * What sends a panel back to the connection test: `pending`, its last test
 * cleared, so the next tick tests it (`network/contract.registration.md` rule
 * 4). A duplicate's name goes with its refusal (CHECK `panel_duplicate_is_refused`).
 */
export const PANEL_RETEST = {
  reviewState: PanelReviewState.pending,
  connectionTestedAt: null,
  connectionTestFault: null,
  connectionTestDetail: null,
  duplicateOfPanelId: null,
} satisfies Prisma.PanelUncheckedUpdateManyInput;
