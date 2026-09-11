import { backendVitestConfig } from '../vitest.shared.mts';

export default backendVitestConfig(import.meta.dirname, 'worker-service');
