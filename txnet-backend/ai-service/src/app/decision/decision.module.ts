import { Module } from '@nestjs/common';

import { ActionLog } from './action-log';
import { CooldownReader } from './cooldown-reader';
import { Holdouts } from './holdout';
import { OptOutInternalController } from './opt-out-internal.controller';
import { OptOuts } from './opt-out';
import { QuietDownReader } from './quiet-down-reader';
import { TypeSwitch } from './type-switch';
import { TypeSwitchInternalController } from './type-switch-internal.controller';

@Module({
  controllers: [OptOutInternalController, TypeSwitchInternalController],
  providers: [ActionLog, CooldownReader, Holdouts, OptOuts, QuietDownReader, TypeSwitch],
  exports: [ActionLog, CooldownReader, Holdouts, OptOuts, QuietDownReader, TypeSwitch],
})
export class DecisionModule {}
