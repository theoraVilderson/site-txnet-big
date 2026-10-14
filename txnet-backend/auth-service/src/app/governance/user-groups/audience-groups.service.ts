import { Injectable } from '@nestjs/common';
import { AudienceGroupOption, pickableAudienceGroups, tenantTransaction } from '@txnet-backend/shared-core';

import { PrismaService } from '../../prisma/prisma.service';

/**
 * The audience picker's list (GR-1-w, ADR-0143 (4)): the groups of the scope
 * this caller may aim a discount, gateway, product, lottery, wheel or campaign
 * at. The rule is shared-core's, so each feature's write refuses exactly what
 * this leaves out. In the caller's `tenantTransaction`: RLS keeps it to the
 * ambient tenant, or a reseller's when its door admitted the caller on its path.
 */
@Injectable()
export class AudienceGroupsService {
  constructor(private readonly prisma: PrismaService) {}

  pickable(acting: readonly string[]): Promise<AudienceGroupOption[]> {
    return tenantTransaction(this.prisma, (tx) => pickableAudienceGroups(tx, acting));
  }
}
