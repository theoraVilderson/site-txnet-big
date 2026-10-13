import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Request } from 'express';

import { RequestHeaders, headerValue } from '../http/headers';
import { acceptRequestId, runWithRequestId } from './request-scope';

/**
 * Opens the request-id scope for the rest of the request (H13). Applied first
 * in a service's `configure`, so every later middleware, guard and handler —
 * and every log line they write — carries the same id, and the caller can
 * quote it back from the response header.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Pick<Request, 'headers'>, res: { setHeader(name: string, value: string): unknown }, next: () => void) {
    const requestId = acceptRequestId(headerValue(req.headers, RequestHeaders.requestId));
    res.setHeader(RequestHeaders.requestId, requestId);
    runWithRequestId(requestId, () => next());
  }
}
