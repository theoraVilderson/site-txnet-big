import { Module } from '@nestjs/common';

import { CooldownReader } from './cooldown-reader';
import { OptOutInternalController } from './opt-out-internal.controller';
import { OptOuts } from './opt-out';
import { QuietDownReader } from './quiet-down-reader';

@Module({
  controllers: [OptOutInternalController],
  providers: [CooldownReader, OptOuts, QuietDownReader],
  exports: [CooldownReader, OptOuts, QuietDownReader],
})
export class DecisionModule {}
