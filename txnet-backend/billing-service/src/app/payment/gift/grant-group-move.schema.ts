import { BackendI18nKeys } from '@txnet-backend/shared-core';
import { z } from 'zod';

import { GrantGroupMoveSource } from '../../traffic/grant-regroup-selection';

const E = BackendI18nKeys.errors.billing;

const id = z.string({ message: E.configActionInvalid }).uuid({ message: E.configActionInvalid });
const reason = z.string({ message: E.configActionInvalid }).trim().min(1, { message: E.configActionInvalid }).max(500, { message: E.configActionInvalid });

/** The most Grants one group move may tick; a whole group is named by its id instead. */
export const GRANT_GROUP_MOVE_MAX_GRANTS = 500;

/** `POST …/grants/:grantId/group` (F-027-et): one Grant, now, to the group named. */
export const grantRegroupSchema = z.object({ toGroupId: id, reason }).strict();

export type GrantRegroupBody = { toGroupId: string; reason: string };

/** The Grants ticked (each once), or every Grant of one group — exactly one of the two. */
const sourceSchema = z.union(
  [
    z
      .object({ grantIds: z.array(id).min(1, { message: E.configActionInvalid }).max(GRANT_GROUP_MOVE_MAX_GRANTS, { message: E.configActionInvalid }) })
      .strict()
      .refine((s) => new Set(s.grantIds).size === s.grantIds.length, { message: E.configActionInvalid }),
    z.object({ fromGroupId: id }).strict(),
  ],
  { message: E.configActionInvalid },
);

/** `POST …/grant-group-moves/count`: the confirm's figures — Grants, configs kept, configs moved. */
export const grantGroupMoveSelectionSchema = z.object({ source: sourceSchema, toGroupId: id }).strict();

/** Written out, not inferred: the app's non-strict build would read the union's fields as optional. */
export type GrantGroupMoveSelection = { source: GrantGroupMoveSource; toGroupId: string };

/** `POST …/grant-group-moves`: the selection, the target, the admin's reason, and a `requestId` minted once per confirm. */
export const grantGroupMoveJobSchema = grantGroupMoveSelectionSchema.extend({ requestId: id, reason }).strict();

export type GrantGroupMoveJobBody = GrantGroupMoveSelection & { requestId: string; reason: string };
