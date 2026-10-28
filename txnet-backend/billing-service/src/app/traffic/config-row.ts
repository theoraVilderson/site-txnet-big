import { randomUUID } from 'node:crypto';

import {
  ConfigProtocol,
  DesiredRemote,
  EnforcementState,
  Prisma,
} from '@prisma/client';

/**
 * The second matching key (network F-027-aa): written into the client's label
 * on every panel family that has one, so a rename on the panel does not orphan
 * the config's usage. Ours and global (`@unique`, invariant 17), and random
 * rather than derived from the `uuid`, because a regenerate rotates the
 * credential and the tag has to survive it. A move is a new row and a new tag.
 */
const claimTag = (): string => `txn-${randomUUID().replace(/-/g, '')}`;

/** A new config's row, before it is written: a fresh credential and claim tag, wanted present and enabled. */
export function configRow(
  grant: {
    id: string;
    tenantId: string;
    userId: string;
    trafficUnlimited: boolean;
  },
  panelId: string,
  protocol: ConfigProtocol,
  credentialGroupId: string | null,
  inboundRemoteId: string | null,
) {
  return {
    tenantId: grant.tenantId,
    userId: grant.userId,
    grantId: grant.id,
    panelId,
    protocol,
    uuid: randomUUID(),
    claimTag: claimTag(),
    credentialGroupId,
    inboundRemoteId,
    // Copied, never re-read: the Grant's flag is set at issue and never
    // changes, and network-service reads only this row (F-111-r).
    trafficUnlimited: grant.trafficUnlimited,
    desiredRemote: DesiredRemote.present,
    desiredEnabled: true,
    enforcementState: EnforcementState.pending,
  } satisfies Prisma.ConfigUncheckedCreateInput;
}
