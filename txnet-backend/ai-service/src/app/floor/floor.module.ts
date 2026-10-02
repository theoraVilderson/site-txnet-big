import { Module } from '@nestjs/common';

import { AttentionModule } from '../attention/attention.module';
import { SafetyFloor } from './safety-floor';
import { SilenceSwitch } from './silence';
import { SilenceInternalController } from './silence-internal.controller';

@Module({
  imports: [AttentionModule],
  controllers: [SilenceInternalController],
  providers: [SafetyFloor, SilenceSwitch],
  exports: [SafetyFloor],
})
export class FloorModule {}
