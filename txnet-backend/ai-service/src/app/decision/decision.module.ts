import { Module } from '@nestjs/common';

import { AttentionModule } from '../attention/attention.module';
import { FloorModule } from '../floor/floor.module';
import { ActionLog } from './action-log';
import { CooldownReader } from './cooldown-reader';
import { DecisionReader } from './decision-reader';
import { DecisionRun } from './decision-run';
import { ActionDelivery } from './delivery';
import { DeliveryInternalController } from './delivery-internal.controller';
import { Holdouts } from './holdout';
import { MySuggestionController } from './my-suggestion.controller';
import { MySuggestionService } from './my-suggestion';
import { OfferGuardrails } from './offer-guardrail';
import { OutcomeInternalController } from './outcome-internal.controller';
import { OutcomeRun } from './outcome-run';
import { OptOutInternalController } from './opt-out-internal.controller';
import { OptOuts } from './opt-out';
import { DecisionPipeline } from './pipeline';
import { QuietDownReader } from './quiet-down-reader';
import { TypeSwitch } from './type-switch';
import { TypeSwitchInternalController } from './type-switch-internal.controller';

@Module({
  imports: [AttentionModule, FloorModule],
  controllers: [DeliveryInternalController, MySuggestionController, OptOutInternalController, OutcomeInternalController, TypeSwitchInternalController],
  providers: [ActionDelivery, ActionLog, CooldownReader, DecisionPipeline, DecisionReader, DecisionRun, Holdouts, MySuggestionService, OfferGuardrails, OptOuts, OutcomeRun, QuietDownReader, TypeSwitch],
  exports: [ActionLog, CooldownReader, DecisionRun, Holdouts, OutcomeRun, OptOuts, QuietDownReader, TypeSwitch],
})
export class DecisionModule {}
