declare namespace Express {
  interface Request {
    language?: string;
    /** Set by `ServiceCallerMiddleware`: a valid `SERVICE_AUTH_TOKEN` was sent. */
    serviceCaller?: boolean;
    /** Set by `ServiceCallerMiddleware`: what per-caller rate limits count against. */
    rateSubject?: string;
  }
}
