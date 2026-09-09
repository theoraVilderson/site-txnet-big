/**
 * Fake `ExecutionContext` / `ArgumentsHost` for guard, pipe and filter specs.
 *
 * Guards only ever touch three things: the request, the handler/class pair the
 * Reflector reads metadata from, and (for filters) the response. Building a
 * whole Nest testing module to get those costs a second per spec file and
 * proves nothing extra, so the specs construct them here instead.
 */
import { ArgumentsHost, ExecutionContext } from '@nestjs/common';

export interface FakeRequest {
  /** Express-style, case-insensitive header lookup — what `AuthGuard` uses. */
  get(name: string): string | undefined;
  headers: Record<string, unknown>;
  method: string;
  originalUrl: string;
  /** Express's path without the query string — what `TenantGuard` matches on. */
  path: string;
  user?: unknown;
  language?: string;
  [key: string]: unknown;
}

export interface ContextOptions {
  /** Header names are matched case-insensitively, as Express does. */
  headers?: Record<string, string | undefined>;
  /** What `AuthGuard` would have attached; `undefined` = unauthenticated. */
  user?: unknown;
  method?: string;
  url?: string;
  /** Language the middleware resolved, read by `I18nExceptionFilter`. */
  language?: string;
  /** Anything else the route handler or a `RateLimit` key function reads. */
  extra?: Record<string, unknown>;
}

export function fakeRequest(options: ContextOptions = {}): FakeRequest {
  const headers: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value !== undefined) headers[name.toLowerCase()] = value;
  }
  const url = options.url ?? '/api/auth/login';
  const request: FakeRequest = {
    headers,
    method: options.method ?? 'POST',
    originalUrl: url,
    path: url.split('?')[0],
    get: (name: string) => headers[name.toLowerCase()] as string | undefined,
    ...options.extra,
  };
  if ('user' in options) request.user = options.user;
  if (options.language) request.language = options.language;
  return request;
}

export interface FakeContext {
  request: FakeRequest;
  context: ExecutionContext;
  /** The two metadata targets a `Reflector` is handed, in order. */
  handler: () => void;
  controllerClass: new () => unknown;
}

export function fakeExecutionContext(options: ContextOptions = {}): FakeContext {
  const request = fakeRequest(options);
  const handler = function routeHandler() {
    /* metadata target only */
  };
  class FakeController {}

  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => undefined,
    }),
    getHandler: () => handler,
    getClass: () => FakeController,
  } as unknown as ExecutionContext;

  return { request, context, handler, controllerClass: FakeController };
}

export interface FakeResponse {
  status: jest.Mock;
  json: jest.Mock;
  /** The body handed to `json()`, or undefined if nothing was sent. */
  body(): Record<string, unknown> | undefined;
  /** The status code passed to `status()`. */
  statusCode(): number | undefined;
}

export function fakeResponse(): FakeResponse {
  const response = {
    status: jest.fn(() => response),
    json: jest.fn(() => response),
  } as unknown as FakeResponse & { status: jest.Mock; json: jest.Mock };

  response.body = () => response.json.mock.calls[0]?.[0];
  response.statusCode = () => response.status.mock.calls[0]?.[0];
  return response;
}

export function fakeArgumentsHost(options: ContextOptions = {}): {
  request: FakeRequest;
  response: FakeResponse;
  host: ArgumentsHost;
} {
  const request = fakeRequest(options);
  const response = fakeResponse();
  const host = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
  return { request, response, host };
}
