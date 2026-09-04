---
id: adr-0007
status: accepted
updated: 2026-09-04
---

# ADR 0007 — Redis is the source of truth for OTP; Postgres is audit only

- **Status:** accepted
- **Date:** 2026-09-04 (documented; predates this doc)
- **Affects units:** identity, auth-api, redis-keyspace

## Context

OTP needs atomic issue (one in-flight code per phone+purpose), TTL, an attempt
counter with a hard cap, and a request cooldown — all under concurrent requests.

## Decision

`OtpStore` keeps the hashed code + `attemptCount` in Redis with a TTL; issue is
guarded by a short `setNx` lock and a cooldown key; verification runs a Lua
script that reads, increments the counter under `KEEPTTL`, and self-destructs the
record after 5 attempts. The `otp_code` Postgres row is written best-effort for
audit/history only and is never consulted for validation. Codes are hashed with
argon2id (like passwords); the plain code is never stored.

## Consequences

- Positive: race-free, self-expiring, no DB load on the hot path.
- Negative / accepted cost: a Redis flush drops in-flight OTPs (acceptable —
  users re-request); audit trail depends on the best-effort write.
- Forecloses: querying "current OTP" from Postgres.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| Postgres as OTP truth | locking + TTL sweeping + hot-path load |
| Redis without Lua (GET then SET) | attempt-count race |

## Revisit trigger

A compliance requirement to retain verifiable OTP issuance records beyond the
best-effort audit row.
