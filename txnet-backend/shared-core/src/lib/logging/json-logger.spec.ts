import { runWithTenant } from '../tenant-context/tenant-context';
import { loggingEnv } from './env';
import { JsonLogger } from './json-logger';
import { runWithRequestId } from './request-scope';

/**
 * H12 (`platform/hosting/contract.md`): one JSON line per call, keyed the way
 * the Go services' `slog` lines are, so one Loki query reads both.
 */
function capture() {
  const lines: string[] = [];
  const logger = new JsonLogger({ service: 'billing-service', format: 'json', write: (line) => lines.push(line) });
  const parsed = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, lines, parsed };
}

describe('JsonLogger', () => {
  it('writes one line per call with time, level, msg, service and context', () => {
    const { logger, lines, parsed } = capture();
    logger.log('payment settled', 'PaymentService');
    expect(lines).toHaveLength(1);
    expect(lines[0].endsWith('\n')).toBe(true);
    const [line] = parsed();
    expect(line).toMatchObject({ level: 'INFO', msg: 'payment settled', service: 'billing-service', context: 'PaymentService' });
    expect(new Date(String(line['time'])).toISOString()).toBe(line['time']);
  });

  it('names levels as slog does', () => {
    const { logger, parsed } = capture();
    logger.warn('w');
    logger.debug('d');
    logger.verbose('v');
    logger.error('e');
    logger.fatal('f');
    expect(parsed().map((line) => line['level'])).toEqual(['WARN', 'DEBUG', 'DEBUG', 'ERROR', 'ERROR']);
  });

  it('adds requestId, tenantId and userId when they are in scope, and nothing when not', () => {
    const { logger, parsed } = capture();
    logger.log('outside');
    runWithRequestId('trace-0001', () => runWithTenant({ id: 'tenant-1' }, () => logger.log('inside')), 'user-1');
    const [outside, inside] = parsed();
    expect(outside).not.toHaveProperty('requestId');
    expect(outside).not.toHaveProperty('tenantId');
    expect(inside).toMatchObject({ requestId: 'trace-0001', tenantId: 'tenant-1', userId: 'user-1' });
  });

  it('adds err and stack for an error, whether thrown or passed as a stack', () => {
    const { logger, parsed } = capture();
    logger.error(new Error('gateway refused'), 'PaymentService');
    logger.error('verify failed', 'Error: x\n    at y', 'Verifier');
    const [thrown, passed] = parsed();
    expect(thrown).toMatchObject({ level: 'ERROR', msg: 'gateway refused', err: 'gateway refused', context: 'PaymentService' });
    expect(String(thrown['stack'])).toContain('gateway refused');
    expect(passed).toMatchObject({ msg: 'verify failed', stack: 'Error: x\n    at y', context: 'Verifier' });
  });

  it('keeps a message that would break the line on one line', () => {
    const { logger, lines } = capture();
    logger.log('a\nb', 'C');
    expect(lines[0].trimEnd().split('\n')).toHaveLength(1);
  });
});

describe('loggingEnv', () => {
  it('defaults to JSON in production and to Nest\'s own output elsewhere, so dev reads as it did', () => {
    expect(loggingEnv({ APP_NAME: 'billing-service', NODE_ENV: 'production' })).toEqual({ service: 'billing-service', format: 'json' });
    expect(loggingEnv({ APP_NAME: 'billing-service', NODE_ENV: 'development', LOG_FORMAT: '' })).toEqual({ service: 'billing-service', format: 'pretty' });
    expect(loggingEnv({ APP_NAME: 'billing-service', LOG_FORMAT: 'json' }).format).toBe('json');
  });

  it('refuses to boot without a service name or with an unknown format', () => {
    expect(() => loggingEnv({ NODE_ENV: 'production' })).toThrow();
    expect(() => loggingEnv({ APP_NAME: 'x', LOG_FORMAT: 'xml' })).toThrow();
  });
});
