import { Module } from '@nestjs/common';
import { ConnectionRegistry } from './connection.registry';
import { RealtimeFanout } from './fanout';
import { RealtimeGateway } from './realtime.gateway';

@Module({
  providers: [ConnectionRegistry, RealtimeFanout, RealtimeGateway],
  exports: [ConnectionRegistry, RealtimeFanout, RealtimeGateway],
})
export class RealtimeModule {}
