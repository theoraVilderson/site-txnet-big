import { Module } from '@nestjs/common';

import { DeltaConsumer } from './delta.consumer';
import { MeteringService } from './metering.service';

@Module({
  providers: [MeteringService, DeltaConsumer],
})
export class MeteringModule {}
