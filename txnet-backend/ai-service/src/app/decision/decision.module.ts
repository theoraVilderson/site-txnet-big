import { Module } from '@nestjs/common';

import { CooldownReader } from './cooldown-reader';
import { Holdouts } from './holdout';
import { OptOutInternalController } from './opt-out-internal.controller';
import { OptOuts } from './opt-out';
import { QuietDownReader } from './quiet-down-reader';

@Module({
  controllers: [OptOutInternalController],
  providers: [CooldownReader, Holdouts, OptOuts, QuietDownReader],
  exports: [CooldownReader, Holdouts, OptOuts, QuietDownReader],
})
export class DecisionModule {}
