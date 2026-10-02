import { Module } from '@nestjs/common';

import { CooldownReader } from './cooldown-reader';
import { OptOutInternalController } from './opt-out-internal.controller';
import { OptOuts } from './opt-out';

@Module({
  controllers: [OptOutInternalController],
  providers: [CooldownReader, OptOuts],
  exports: [CooldownReader, OptOuts],
})
export class DecisionModule {}
