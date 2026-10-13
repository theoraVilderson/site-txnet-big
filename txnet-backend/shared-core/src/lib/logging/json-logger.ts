import { ConsoleLogger, type LoggerService, type Provider } from '@nestjs/common';

import { TenantContext } from '../tenant-context/tenant-context';
import { type LogFormat, loggingEnv } from './env';
import { currentRequestId, currentRequestUserId } from './request-scope';

/** The slog level names (H12), so a Loki `level` label means the same for Go and Node. */
type LogLevelName = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

/** One H12 line; the optional keys appear only when known. */
interface LogLine {
  time: string;
  level: LogLevelName;
  msg: string;
  service: string;
  context?: string;
  requestId?: string;
  tenantId?: string;
  userId?: string;
  err?: string;
  stack?: string;
}

export interface JsonLoggerOptions {
  service: string;
  format: LogFormat;
  /** Where a line goes; stdout unless a spec captures it. */
  write?: (line: string) => void;
}

/**
 * Nest's logger, writing one JSON line per call (H12) with the request, tenant
 * and user in scope, so Promtail ships it as-is and `| json` queries it. In
 * `pretty` format every call goes to Nest's own `ConsoleLogger` unchanged.
 */
export class JsonLogger implements LoggerService {
  private readonly pretty?: ConsoleLogger;
  private readonly write: (line: string) => void;

  constructor(private readonly options: JsonLoggerOptions) {
    if (options.format === 'pretty') this.pretty = new ConsoleLogger();
    this.write = options.write ?? ((line) => process.stdout.write(line));
  }

  log(message: unknown, ...params: unknown[]) {
    if (this.pretty) return this.pretty.log(message, ...params);
    this.emit('INFO', message, params);
  }

  warn(message: unknown, ...params: unknown[]) {
    if (this.pretty) return this.pretty.warn(message, ...params);
    this.emit('WARN', message, params);
  }

  debug(message: unknown, ...params: unknown[]) {
    if (this.pretty) return this.pretty.debug(message, ...params);
    this.emit('DEBUG', message, params);
  }

  verbose(message: unknown, ...params: unknown[]) {
    if (this.pretty) return this.pretty.verbose(message, ...params);
    this.emit('DEBUG', message, params);
  }

  error(message: unknown, ...params: unknown[]) {
    if (this.pretty) return this.pretty.error(message, ...params);
    this.emit('ERROR', message, params);
  }

  /** slog has no fatal level; a fatal line is an ERROR one. */
  fatal(message: unknown, ...params: unknown[]) {
    if (this.pretty) return this.pretty.fatal(message, ...params);
    this.emit('ERROR', message, params);
  }

  private emit(level: LogLevelName, message: unknown, params: unknown[]) {
    const { context, stack } = splitParams(params);
    const thrown = message instanceof Error ? message : undefined;
    // Absent fields are `undefined`, which JSON.stringify leaves out of the line.
    const line: LogLine = {
      time: new Date().toISOString(),
      level,
      msg: messageText(message),
      service: this.options.service,
      context,
      requestId: currentRequestId(),
      tenantId: TenantContext.currentOrNull()?.id,
      userId: currentRequestUserId(),
      err: thrown?.message,
      stack: stack ?? thrown?.stack,
    };
    // JSON.stringify escapes every newline, which is what keeps one call one line.
    this.write(`${JSON.stringify(line)}\n`);
  }
}

function messageText(message: unknown): string {
  if (message instanceof Error) return message.message;
  if (typeof message === 'string') return message;
  return JSON.stringify(message) ?? String(message);
}

/**
 * Nest's calling convention: the last string parameter is the context, and
 * for `error` a string before it is the stack. A lone string that spans lines
 * is a stack with no context — how `ExceptionsHandler` calls `error`.
 */
function splitParams(params: unknown[]): { context?: string; stack?: string } {
  const strings = params.filter((p): p is string => typeof p === 'string');
  if (strings.length >= 2) return { stack: strings[strings.length - 2], context: strings[strings.length - 1] };
  const [only] = strings;
  if (only === undefined) return {};
  return only.includes('\n') ? { stack: only } : { context: only };
}

/** Registers {@link JsonLogger} for `app.useLogger(app.get(JsonLogger))` (H12). */
export const JSON_LOGGER_PROVIDER: Provider = {
  provide: JsonLogger,
  useFactory: () => new JsonLogger(loggingEnv()),
};
