import { Module } from '@nestjs/common';

import { AttentionModule } from '../attention/attention.module';
import { ActionLog } from './action-log';
import { CooldownReader } from './cooldown-reader';
import { DecisionReader } from './decision-reader';
import { DecisionRun } from './decision-run';
import { Holdouts } from './holdout';
import { OfferGuardrails } from './offer-guardrail';
import { OptOutInternalController } from './opt-out-internal.controller';
import { OptOuts } from './opt-out';
import { DecisionPipeline } from './pipeline';
import { QuietDownReader } from './quiet-down-reader';
import { TypeSwitch } from './type-switch';
import { TypeSwitchInternalController } from './type-switch-internal.controller';

@Module({
  imports: [AttentionModule],
  controllers: [OptOutInternalController, TypeSwitchInternalController],
  providers: [ActionLog, CooldownReader, DecisionPipeline, DecisionReader, DecisionRun, Holdouts, OfferGuardrails, OptOuts, QuietDownReader, TypeSwitch],
  exports: [ActionLog, CooldownReader, DecisionRun, Holdouts, OptOuts, QuietDownReader, TypeSwitch],
})
export class DecisionModule {}
