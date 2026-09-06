import { Module } from '@nestjs/common';
import { AuthApiClient } from './auth-api.client';

@Module({
  providers: [AuthApiClient],
  exports: [AuthApiClient],
})
export class AuthApiModule {}
