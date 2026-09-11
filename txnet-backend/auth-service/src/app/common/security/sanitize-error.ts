import { BackendI18nKeys } from '@txnet-backend/shared-core';
import { HttpException, HttpStatus } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

/**
 * Turns ANY thrown value into something safe to send to a client.
 *
 * Rule: the outward `msg` is always an i18n **key** in the `errors` namespace —
 * never a raw error message, DB error text, third-party error, stack frame or
 * internal identifier. The real detail is returned in `detail` for the server
 * log ONLY, correlated by `ref`.
 *
 * A value coming off an exception is only forwarded as-is when it *looks like*
 * an i18n key (a dotted identifier, no spaces/punctuation, bounded length) —
 * i.e. something the application deliberately chose. Everything else is replaced
 * by a generic key derived from the HTTP status.
 */

export interface FieldError {
  path: string;
  i18nKey: string;
}

export interface SanitizedError {
  status: number;
  /** i18n key in the `errors` namespace — safe to translate and send out */
  msgKey: string;
  fieldErrors?: FieldError[];
  /** short correlation id — also written to the server log */
  ref: string;
  /** full detail — SERVER LOG ONLY, never sent to the client */
  detail: string;
  logLevel: 'warn' | 'error';
}

// dotted identifier with at least one segment separator, no spaces/punctuation
/**
 * The shared `errors` catalogue, as generated constants (F-081, ADR-0036).
 *
 * Every generic key below used to be a literal, and five of them —
 * `auth.authorizationRequired`, `permissions.forbidden`, `system.unexpected`,
 * `system.unavailable` and the gateway's `auth.*` — are also what `auth-handler`
 * answers with in Go. Two languages spelling one JSON file with nothing
 * comparing them: a key renamed in `errors.json` is now a compile error here
 * and a build failure there.
 */
const E = BackendI18nKeys.errors;

const KEY_RE = /^[a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9_]+){1,5}$/;
const isSafeKey = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 64 && KEY_RE.test(v);

const newRef = (): string => randomBytes(5).toString('hex'); // 10 hex chars

function genericKeyFor(status: number): string {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return E.system.badRequest;
    case HttpStatus.UNAUTHORIZED:
      return E.auth.authorizationRequired;
    case HttpStatus.FORBIDDEN:
      return E.permissions.forbidden;
    case HttpStatus.NOT_FOUND:
      return E.system.notFound;
    case HttpStatus.CONFLICT:
      return E.system.conflict;
    case HttpStatus.TOO_MANY_REQUESTS:
      return E.system.rateLimit;
    case HttpStatus.SERVICE_UNAVAILABLE:
      return E.system.unavailable;
    default:
      return status >= 500 ? E.system.unexpected : E.system.badRequest;
  }
}

function describe(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code
      ? ` code=${String((e as { code?: unknown }).code)}`
      : '';
    return `${e.name}: ${e.message}${code}\n${e.stack ?? ''}`.slice(0, 4000);
  }
  try {
    return `non-error thrown: ${JSON.stringify(e)}`.slice(0, 2000);
  } catch {
    return `non-error thrown: ${String(e)}`.slice(0, 2000);
  }
}

/**
 * Prisma known errors → a generic outcome. The Prisma `code`, `meta` and
 * `target` (table/column names) are NEVER exposed — only logged.
 * Duck-typed so this file has no dependency on the generated client.
 */
function fromPrisma(e: unknown): { status: number; msgKey: string } | null {
  const err = e as { name?: string; code?: string };
  const name = err?.name ?? '';

  if (name === 'PrismaClientKnownRequestError' && typeof err.code === 'string') {
    switch (err.code) {
      case 'P2002': // unique constraint
      case 'P2003': // foreign key constraint
        return { status: 409, msgKey: E.system.conflict };
      case 'P2025': // record required but not found
        return { status: 404, msgKey: E.system.notFound };
      case 'P2000': // value too long for column
        return { status: 400, msgKey: E.system.badRequest };
      case 'P1000': // auth failed
      case 'P1001': // can't reach db
      case 'P1002': // db timeout
      case 'P1008': // operation timed out
      case 'P1017': // server closed the connection
        return { status: 503, msgKey: E.system.unavailable };
      default:
        return { status: 500, msgKey: E.system.unexpected };
    }
  }
  if (name === 'PrismaClientInitializationError') {
    return { status: 503, msgKey: E.system.unavailable };
  }
  if (
    name === 'PrismaClientValidationError' ||
    name === 'PrismaClientRustPanicError' ||
    name === 'PrismaClientUnknownRequestError'
  ) {
    return { status: 500, msgKey: E.system.unexpected };
  }
  return null;
}

export function sanitizeError(exception: unknown): SanitizedError {
  const ref = newRef();
  const detail = describe(exception);

  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const res = exception.getResponse() as unknown;
    const logLevel: 'warn' | 'error' = status >= 500 ? 'error' : 'warn';
    const obj =
      res && typeof res === 'object' ? (res as Record<string, unknown>) : null;

    // Validation errors: field-level entries from ZodValidationPipe are i18n keys.
    if (obj && Array.isArray(obj.fieldErrors)) {
      const fieldErrors = (obj.fieldErrors as unknown[])
        .map((f) => f as { path?: unknown; i18nKey?: unknown })
        .filter((f) => isSafeKey(f?.i18nKey))
        .map((f) => ({
          path: String(f.path ?? ''),
          i18nKey: f.i18nKey as string,
        }));
      return {
        status,
        msgKey: isSafeKey(obj.i18nKey)
          ? (obj.i18nKey as string)
          : E.system.validationFailed,
        fieldErrors,
        ref,
        detail,
        logLevel,
      };
    }

    // An explicit i18n key on the body, or a `message` that *is* a key.
    const candidate = obj ? (obj.i18nKey ?? obj.message) : res;
    return {
      status,
      msgKey: isSafeKey(candidate) ? candidate : genericKeyFor(status),
      ref,
      detail,
      logLevel,
    };
  }

  const prisma = fromPrisma(exception);
  if (prisma) {
    return {
      ...prisma,
      ref,
      detail,
      logLevel: prisma.status >= 500 ? 'error' : 'warn',
    };
  }

  // Generic Error / third-party throw / string / anything else → opaque 500.
  return {
    status: 500,
    msgKey: E.system.unexpected,
    ref,
    detail,
    logLevel: 'error',
  };
}
