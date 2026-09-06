import { NotFoundException } from '@nestjs/common';
import { ServiceOnlyGuard } from './service-only.guard';
import { fakeExecutionContext } from '../../../test-support/execution-context';

describe('ServiceOnlyGuard', () => {
  const guard = new ServiceOnlyGuard();

  it('lets a proven service through', () => {
    const { context } = fakeExecutionContext({
      extra: { serviceCaller: true },
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('answers 404 — not 401 — to anyone else, so the seam cannot be probed', () => {
    const { context } = fakeExecutionContext();

    expect(() => guard.canActivate(context)).toThrow(NotFoundException);
  });
});
