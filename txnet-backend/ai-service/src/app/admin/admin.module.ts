import { Module } from '@nestjs/common';

import { DecisionModule } from '../decision/decision.module';
import { PolicyModule } from '../policy/policy.module';
import { AiAdminController } from './ai-admin.controller';
import { AiAdminSettings } from './ai-admin-settings';
import { AiManageGuard } from './ai-manage.guard';
import { AtRisk } from './at-risk';
import { Margins } from './margins';
import { PlanLayout } from './plan-layout';
import { ResellerForecasts } from './reseller-forecast';
import { UsageReport } from './usage-report';

/** The reseller's AI admin (F-038-j1): `/api/ai/admin/*`, behind the gate and `ai.manage`. */
@Module({
  imports: [DecisionModule, PolicyModule],
  controllers: [AiAdminController],
  providers: [AiAdminSettings, AiManageGuard, AtRisk, Margins, PlanLayout, ResellerForecasts, UsageReport],
})
export class AdminModule {}
