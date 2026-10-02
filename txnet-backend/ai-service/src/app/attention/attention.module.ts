import { Module } from '@nestjs/common';

import { AttentionBudget } from './attention-budget.service';

@Module({
  providers: [AttentionBudget],
  exports: [AttentionBudget],
})
export class AttentionModule {}
