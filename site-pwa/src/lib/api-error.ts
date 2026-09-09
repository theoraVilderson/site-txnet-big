/**
 * What a failed `auth-api` call becomes on this side of the wire.
 *
 * `auth-api` translates before it answers (`I18nExceptionFilter`), so `message`
 * and every `fieldErrors[].message` are already in the caller's language and go
 * straight on screen — this file never looks a key up. The one case with no
 * server text is `unreachable`: the request never got an answer we could read,
 * so the caller supplies its own translated line (`useApiErrorMessage`).
 */

/** One field-level complaint, already translated by `auth-api`. */
export interface ApiFieldError {
  /** The request-body path the complaint is about, e.g. `phoneNumber`. */
  path: string;
  message: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly fieldErrors: ApiFieldError[];
  /** Correlation id for the server-side log line — shown so a user can quote it. */
  readonly ref?: string;
  /**
   * True when `message` did NOT come from `auth-api`: the network failed, or
   * the answer had no envelope to read. Nothing here is translated, so a UI
   * must show its own string instead of `message`.
   */
  readonly unreachable: boolean;

  constructor(
    message: string,
    init: {
      status: number;
      fieldErrors?: ApiFieldError[];
      ref?: string;
      unreachable?: boolean;
      cause?: unknown;
    },
  ) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "ApiError";
    this.status = init.status;
    this.fieldErrors = init.fieldErrors ?? [];
    this.ref = init.ref;
    this.unreachable = init.unreachable ?? false;
  }

  /** `auth-api` never answered, or answered something this client cannot read. */
  static unreachable(detail: string, cause?: unknown): ApiError {
    return new ApiError(detail, { status: 0, unreachable: true, cause });
  }
}

/**
 * Field errors keyed by path, for a form that wants to put each one under its
 * own input rather than in the summary.
 */
export function fieldErrorsByPath(e: unknown): Record<string, string> {
  if (!(e instanceof ApiError)) return {};
  const out: Record<string, string> = {};
  for (const f of e.fieldErrors) if (f.path && !(f.path in out)) out[f.path] = f.message;
  return out;
}
