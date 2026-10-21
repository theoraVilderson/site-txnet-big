import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DriverType } from '@prisma/client';
import { serviceCallHeaders } from '@txnet-backend/shared-core';
import { z } from 'zod';

/** The source routes on `network-service` (network `contract.source.md`). Service callers only. */
const SNAPSHOT_PATH = '/api/internal/source/snapshot';
/** The run's source login on `tenant-service` (tenant `contract.source-login.md`). Service callers only. */
const DESTROY_LOGIN_PATH = '/api/internal/vault/source-credential/destroy';

/** The seam could not be asked: unset, unreachable, or an answer in no shape it gives. Retried by the next tick. */
export class MigrationSeamUnavailable extends Error {
  constructor(detail: string) {
    super(`migration seam unavailable: ${detail}`);
    this.name = 'MigrationSeamUnavailable';
  }
}

/** The other side answered a refusal with its reason (`source_login_refused`, `credential_unavailable`, …). */
export class MigrationSeamRefused extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(`migration seam refused: ${reason} (${status})`);
    this.name = 'MigrationSeamRefused';
  }
}

/** Where one service's internal seam is, from the validated env (C-26). */
export type Seam = { baseUrl: string; token: string; timeoutMs: number };

export function seamOf(config: ConfigService, baseUrlKey: string, timeoutKey: string): Seam {
  return {
    baseUrl: String(config.get<string>(baseUrlKey, '') ?? '').replace(/\/+$/, ''),
    token: String(config.get<string>('SERVICE_AUTH_TOKEN', '') ?? ''),
    timeoutMs: Number(config.get<number>(timeoutKey)),
  };
}

/** A refusal's reason: a short identifier, so nothing else from the body can pass as one. */
const REASON = /^[a-z_]{1,64}$/;

function reasonOf(body: Record<string, unknown> | null, status: number): string {
  const error = body?.['error'];
  const nested = error && typeof error === 'object' ? (error as Record<string, unknown>)['reason'] : undefined;
  const found = [nested, body?.['reason']].find((c): c is string => typeof c === 'string' && REASON.test(c));
  return found ?? `status_${status}`;
}

/**
 * POST one internal route and answer its `data`. Both envelopes are read: the
 * Go services' `{data}` / `{error: {reason}}` and Nest's `{ok, data}` /
 * `{reason}`. **No error carries the body**, which may hold a login.
 */
export async function postToSeam(seam: Seam, path: string, body: unknown, headers: Record<string, string> = {}): Promise<unknown> {
  if (!seam.baseUrl) throw new MigrationSeamUnavailable(`no base URL for ${path}`);
  if (!seam.token) throw new MigrationSeamUnavailable('SERVICE_AUTH_TOKEN is not set');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), seam.timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${seam.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...serviceCallHeaders(seam.token), ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    throw new MigrationSeamUnavailable(`${path} did not answer (${(e as Error).name})`);
  } finally {
    clearTimeout(timer);
  }
  const answer = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) throw new MigrationSeamRefused(response.status, reasonOf(answer, response.status));
  if (!answer || typeof answer !== 'object' || !('data' in answer)) throw new MigrationSeamUnavailable(`${path} answered no data`);
  return answer['data'];
}

/** One inbound as the snapshot answers it; clients are parsed one by one by the plan (`sourceClientSchema`). */
const snapshotSchema = z.object({
  inbounds: z.array(z.object({ remoteId: z.string().min(1).max(200), tag: z.string().max(200), protocol: z.string().max(64) })),
  clients: z.array(z.unknown()),
});
export type SourceSnapshot = z.infer<typeof snapshotSchema>;

/**
 * Reads a run's source panel through `network-service` (F-201-b): the bulk
 * calls only, never a write. The address and login are the vault's, by the
 * run's id (F-201-d) — never in this request.
 */
@Injectable()
export class SourceSnapshotReader {
  private readonly seam: Seam;

  constructor(config: ConfigService) {
    this.seam = seamOf(config, 'NETWORK_API_BASE_URL', 'NETWORK_API_TIMEOUT_MS');
  }

  async snapshot(tenantId: string, family: DriverType, runId: string): Promise<SourceSnapshot> {
    const data = await postToSeam(this.seam, SNAPSHOT_PATH, { tenantId, family, credentialRef: runId });
    const parsed = snapshotSchema.safeParse(data);
    if (!parsed.success) throw new MigrationSeamUnavailable(`${SNAPSHOT_PATH} answered no snapshot`);
    return parsed.data;
  }
}

/**
 * Ends a run's source login in the reseller's vault (tenant rule 5): at a
 * cancel and at the commit's end. Idempotent on the other side; a later read
 * of a closed run destroys it anyway.
 */
@Injectable()
export class SourceLoginVault {
  private readonly seam: Seam;

  constructor(config: ConfigService) {
    this.seam = seamOf(config, 'TENANT_API_BASE_URL', 'TENANT_API_TIMEOUT_MS');
  }

  async destroy(tenantId: string, runId: string): Promise<void> {
    await postToSeam(this.seam, DESTROY_LOGIN_PATH, { tenantId, credentialRef: runId });
  }
}
