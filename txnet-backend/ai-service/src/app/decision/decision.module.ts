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
import { Offers } from './offers';
import { OffersInternalController } from './offers-internal.controller';
import { OutcomeInternalController } from './outcome-internal.controller';
import { OutcomeRun } from './outcome-run';
import { OptOutInternalController } from './opt-out-internal.controller';
import { OptOuts } from './opt-out';
import { DecisionPipeline } from './pipeline';
import { ResellerReader } from '../profile/reseller-reader';
import { QuietDownReader } from './quiet-down-reader';
import { ResellerDecisionRun } from './reseller-decision';
import { TypeSwitch } from './type-switch';
import { TypeSwitchInternalController } from './type-switch-internal.controller';

@Module({
  imports: [AttentionModule, FloorModule],
  controllers: [DeliveryInternalController, MySuggestionController, OffersInternalController, OptOutInternalController, OutcomeInternalController, TypeSwitchInternalController],
  providers: [ActionDelivery, ActionLog, CooldownReader, DecisionPipeline, DecisionReader, DecisionRun, Holdouts, MySuggestionService, OfferGuardrails, Offers, OptOuts, OutcomeRun, QuietDownReader, ResellerDecisionRun, ResellerReader, TypeSwitch],
  exports: [ActionLog, CooldownReader, DecisionRun, Holdouts, Offers, OutcomeRun, OptOuts, QuietDownReader, ResellerDecisionRun, ResellerReader, TypeSwitch],
})
export class DecisionModule {}
