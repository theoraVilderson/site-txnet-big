import { describe, expect, it } from 'vitest';

import { errorLine } from './log-line';

describe('errorLine', () => {
  it('puts a Prisma message, which opens with blank lines, on the one log line', () => {
    const e = new Error('\nInvalid `prisma.grant.findUnique()` invocation:\n\n\nThe column `panel.inboundPlacement` does not exist in the current database.');
    expect(errorLine(e)).toBe('Invalid `prisma.grant.findUnique()` invocation: The column `panel.inboundPlacement` does not exist in the current database.');
  });

  it('names a throw that is not an Error rather than printing nothing', () => {
    expect(errorLine('boom')).toBe('boom');
    expect(errorLine(new Error(''))).toBe('Error (no message)');
  });
});
