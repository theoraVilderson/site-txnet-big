import { Module } from '@nestjs/common';

import { CooldownReader } from './cooldown-reader';

@Module({
  providers: [CooldownReader],
  exports: [CooldownReader],
})
export class DecisionModule {}
