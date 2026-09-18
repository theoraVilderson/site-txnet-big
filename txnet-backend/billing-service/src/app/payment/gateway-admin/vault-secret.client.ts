import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RequestHeaders } from '@txnet-backend/shared-core';

import type {
  GatewaySecretState,
  GatewaySecretTarget,
  GatewaySecretValues,
  GatewaySecretWriter,
  GatewaySecretsState,
} from './gateway-admin.service';

/** The seam on `tenant-service` (F-102-a, moved by F-018-ab). Service callers only; 404 otherwise. */
const SEAM = '/api/internal/vault/gateway-credential';

/** The seam could not answer: unset, unreachable, or a status it should never give. The message names no value. */
export class GatewaySecretsUnavailable extends Error {
  constructor(detail: string) {
    super(`gateway secrets unavailable: ${detail}`);
    this.name = 'GatewaySecretsUnavailable';
  }
}

/** `tenant-service` refused on a rule of its own — the owner it re-derived is not the one named, or the row is gone. */
export class GatewaySecretsRefused extends Error {
  constructor(readonly status: 400 | 403 | 404, readonly reason: string) {
    super(`gateway secrets refused: ${reason}`);
    this.name = 'GatewaySecretsRefused';
  }
}

const REFUSALS = new Set([400, 403, 404]);

/**
 * `GatewaySecretWriter` over HTTP (F-102-c, D-31): the one place in
 * `billing-service` a gateway's secret exists, and only for the length
 * of one `fetch`.
 *
 * The shape of `worker-service`'s jobs on the same seam (`TENANT_API_BASE_URL`,
 * `SERVICE_AUTH_TOKEN`, an abort timer) with two differences that are the point
 * of this class:
 *
 *  - **the answer is picked**, field by field, so a value or fingerprint added
 *    to the other side's reply by mistake stops here instead of reaching the
 *    panel;
 *  - **no error carries the request**. A failed call is the thing that gets
 *    logged, and its body is the secret.
 *
 * Both variables are read at call time and optional at boot, like the worker's:
 * a billing service with the seam unset still takes payments, and only the
 * management routes refuse.
 */
@Injectable()
export class VaultSecretClient implements GatewaySecretWriter {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.baseUrl = String(config.get<string>('TENANT_API_BASE_URL', '') ?? '').replace(/\/+$/, '');
    this.token = String(config.get<string>('SERVICE_AUTH_TOKEN', '') ?? '');
    this.timeoutMs = Number(config.get<number>('TENANT_API_TIMEOUT_MS', 10_000));
  }

  set(target: GatewaySecretTarget, values: GatewaySecretValues, actorId: string): Promise<GatewaySecretsState> {
    return this.post('', { ...target, ...values, actorId });
  }

  state(target: GatewaySecretTarget): Promise<GatewaySecretsState> {
    return this.post('/state', target);
  }

  revoke(target: GatewaySecretTarget): Promise<GatewaySecretsState> {
    return this.post('/revoke', target);
  }

  private async post(path: string, body: object): Promise<GatewaySecretsState> {
    if (!this.baseUrl) throw new GatewaySecretsUnavailable('TENANT_API_BASE_URL is not set');
    if (!this.token) throw new GatewaySecretsUnavailable('SERVICE_AUTH_TOKEN is not set');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${SEAM}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [RequestHeaders.serviceToken]: this.token },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      // The error of a failed fetch names the URL, never the body — but it is
      // replaced anyway, so that nothing about this call's input can ride along.
      throw new GatewaySecretsUnavailable(`${SEAM}${path} did not answer (${(e as Error).name})`);
    } finally {
      clearTimeout(timer);
    }

    const answer = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) {
      if (REFUSALS.has(response.status)) {
        throw new GatewaySecretsRefused(response.status as 400 | 403 | 404, this.reasonOf(answer) ?? `status_${response.status}`);
      }
      throw new GatewaySecretsUnavailable(`${SEAM}${path} answered ${response.status}`);
    }

    // tenant-service wraps answers in the shared envelope; accept both shapes.
    const data = (answer && typeof answer === 'object' && 'data' in answer ? answer['data'] : answer) as Record<string, unknown> | null;
    return {
      merchantId: this.pick(data?.['merchantId']),
      secretKey: this.pick(data?.['secretKey']),
      webhookSecret: this.pick(data?.['webhookSecret']),
    };
  }

  private pick(raw: unknown): GatewaySecretState {
    const r = (raw ?? {}) as Record<string, unknown>;
    return {
      configured: r['configured'] === true,
      version: typeof r['version'] === 'number' ? r['version'] : null,
      rotatedAt: typeof r['rotatedAt'] === 'string' ? r['rotatedAt'] : null,
    };
  }

  /** A refusal's reason code — a short identifier, so nothing else from the body can pass as one. */
  private reasonOf(answer: Record<string, unknown> | null): string | null {
    const candidates = [answer?.['reason'], (answer?.['error'] as Record<string, unknown> | undefined)?.['reason']];
    const found = candidates.find((c) => typeof c === 'string' && /^[a-z_]{1,64}$/.test(c));
    return (found as string | undefined) ?? null;
  }
}
