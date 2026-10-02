import { Module } from '@nestjs/common';

import { AiTenantPolicy } from './ai-tenant-policy';

@Module({
  providers: [AiTenantPolicy],
  exports: [AiTenantPolicy],
})
export class PolicyModule {}
