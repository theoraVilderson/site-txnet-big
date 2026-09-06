# auth-service-e2e

The `auth-service` HTTP contract, exercised the way a client meets it.

```bash
npm run test:e2e                 # from txnet-backend/
npx nx e2e auth-service-e2e      # same thing through Nx
```

Needs Docker. A run takes ~2 minutes, most of it the containers.

## What runs

`AppModule` is booted in-process and driven with supertest, with everything
`main.ts` does to the app repeated in `src/support/app.ts` — the global `api`
prefix, the ValidationPipe, the CORS policy and `I18nExceptionFilter`. Those
are part of the wire contract: the prefix decides the paths and the filter
decides the error envelope, so a harness that skipped them would be testing a
different service.

Postgres and Redis are real, in throwaway containers started once per run
(`src/support/infra.ts`). The schema is built by the repo's own
`prisma db push`, then seeded by the repo's own `prisma/seed.js` — a broken
bootstrap fails here rather than in production. Between tests the tables are
emptied and the Redis database is flushed, so no test inherits another's rate
limit window.

Images default to the mirror the dev environment has to use; override with
`TEST_POSTGRES_IMAGE` / `TEST_REDIS_IMAGE` (CI sets them to Docker Hub).

## The two substitutions

Everything else is the real thing. Only these two are replaced, and both are
recorded here so nobody has to read the harness to find out:

- **`LocaleService`** — it talks gRPC to `locale-service`, a separate product
  with its own tests. The stub translates nothing, so an error body's `msg` is
  the i18n **key** verbatim. That is what the specs assert: the contract is
  about which key comes back, not the Persian sentence rendered from it.
- **OTP delivery** — `OTP_DELIVERY_MODE=console`, the dev escape hatch that
  already exists in `OtpService`. The Redis record, the hash, the cooldown and
  the attempt counter are all real; only the last hop to an SMS provider is a
  line on stdout, which `src/support/otp.ts` reads. That is as close as a test
  gets to being the person holding the phone.

`OTP_ALLOWED_CHANNELS=sms`, so every OTP flow stays on the "a code was sent"
branch. The `linkRequired` branch (F-0202/F-0203) belongs with the bot-link
specs, which need a fake messenger rather than a fake sender.

## Files

| file | covers |
|---|---|
| `auth-flow.e2e.spec.ts` | register -> OTP -> verify-phone -> login (password and OTP) -> refresh -> logout |
| `password-reset.e2e.spec.ts` | forgot -> verify-otp -> reset, and the total session revocation around it |
| `gates.e2e.spec.ts` | the captcha challenge/verify/spend cycle, the per-IP limits, the per-account login lockout |
| `contract.e2e.spec.ts` | the envelopes, the `/api` prefix, the refresh cookie's attributes, CORS, status codes |

Writing these turned up two mismatches with
`docs/interfaces/auth-api/contract.md`, both since resolved: the unrouted
`I18nController`/`AppController` were deleted, and the contract now documents
all three response envelopes instead of one. `contract.e2e.spec.ts` pins
them.
