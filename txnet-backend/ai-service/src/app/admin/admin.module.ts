import { Module } from '@nestjs/common';

import { DecisionModule } from '../decision/decision.module';
import { PolicyModule } from '../policy/policy.module';
import { AiAdminController } from './ai-admin.controller';
import { AiAdminSettings } from './ai-admin-settings';
import { AiManageGuard } from './ai-manage.guard';
import { AtRisk } from './at-risk';

/** The reseller's AI admin (F-038-j1): `/api/ai/admin/*`, behind the gate and `ai.manage`. */
@Module({
  imports: [DecisionModule, PolicyModule],
  controllers: [AiAdminController],
  providers: [AiAdminSettings, AiManageGuard, AtRisk],
})
export class AdminModule {}
