import { Module } from '@nestjs/common';
import { ConnectionRegistry } from './connection.registry';
import { RealtimeFanout } from './fanout';
import { RealtimeGateway } from './realtime.gateway';
import { TenantSocketWatch } from './tenant-status';

@Module({
  providers: [ConnectionRegistry, RealtimeFanout, TenantSocketWatch, RealtimeGateway],
  exports: [ConnectionRegistry, RealtimeFanout, RealtimeGateway],
})
export class RealtimeModule {}
