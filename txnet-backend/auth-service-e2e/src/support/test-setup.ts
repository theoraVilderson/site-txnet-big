/* eslint-disable */
// Runs in every worker before each spec file is imported — early enough that
// `AppModule`'s ConfigModule sees the e2e environment.
import { applyE2eEnv } from './env';

applyE2eEnv();
