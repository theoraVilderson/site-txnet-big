import { BadRequestException, Body, Controller, Delete, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ServiceOnlyGuard, type SourcePanelLogin, ZodValidationPipe } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';
import { refusalException, type RefusalStatus } from '../request/refusal';
import { SetSourceCredentialInput, setSourceCredentialSchema } from './source-credential.schema';
import { SourceCredentialRefused, SourceCredentialRejection, SourceCredentialService, SourceCredentialState } from './source-credential.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every refusal gets a status; a new reason does not compile until it gets one. */
const STATUS: Record<SourceCredentialRejection, RefusalStatus> = {
  not_allowed: 403,
  reseller_suspended: 403,
  reseller_not_found: 404,
  reseller_terminated: 409,
  run_not_found: 404,
  not_a_panel_run: 422,
  run_closed: 409,
  credential_unavailable: 404,
};

/**
 * A reseller's source login for one import run (F-201-d, D-63):
 * `PUT|DELETE /api/tenants/:id/migration-runs/:runId/source-login`. Admitted
 * by `ResellerAccess` with `migration.manage`, as every route naming a
 * reseller is (no `PlatformPermissionGuard`). `PUT` answers
 * `{configured, expiresAt}` — never the address or the login; `DELETE` 204.
 */
@Controller('tenants/:id/migration-runs/:runId/source-login')
export class SourceCredentialController {
  constructor(private readonly credentials: SourceCredentialService) {}

  @Put()
  set(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('runId', new ParseUUIDPipe()) runId: string,
    @Body(new ZodValidationPipe(setSourceCredentialSchema)) body: SetSourceCredentialInput,
  ): Promise<SourceCredentialState> {
    const login = { apiBaseUrl: body.apiBaseUrl, clientBaseUrl: body.clientBaseUrl ?? null, login: body.login };
    return refusing(() => this.credentials.set(actorOf(req), id, runId, login));
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Req() req: Request, @Param('id', new ParseUUIDPipe()) id: string, @Param('runId', new ParseUUIDPipe()) runId: string): Promise<void> {
    return refusing(() => this.credentials.remove(actorOf(req), id, runId));
  }
}

type RunBody = { tenantId?: unknown; credentialRef?: unknown };

/**
 * The two service-only seams on it: `POST /api/internal/vault/source-credential/use`,
 * `network-service`'s source read (`{tenantId, credentialRef}` → the address
 * and login, the only route that answers them), and `/destroy`, the import
 * engine's at commit or cancel (→ `{destroyed}`, a count). `credentialRef` is
 * the run id. A 404 to anyone else, as every internal vault route.
 */
@Controller('internal/vault/source-credential')
@UseGuards(ServiceOnlyGuard)
export class SourceCredentialInternalController {
  constructor(private readonly credentials: SourceCredentialService) {}

  @Post('use')
  @HttpCode(HttpStatus.OK)
  async use(@Body() body: RunBody): Promise<{ credentials: string; apiBaseUrl: string; clientBaseUrl: string | null }> {
    const { tenantId, runId } = runOf(body);
    const source: SourcePanelLogin = await refusing(() => this.credentials.use(tenantId, runId));
    return { credentials: source.login, apiBaseUrl: source.apiBaseUrl, clientBaseUrl: source.clientBaseUrl };
  }

  @Post('destroy')
  @HttpCode(HttpStatus.OK)
  async destroy(@Body() body: RunBody): Promise<{ destroyed: number }> {
    const { tenantId, runId } = runOf(body);
    return { destroyed: await this.credentials.destroy(tenantId, runId) };
  }
}

function runOf(body: RunBody | undefined): { tenantId: string; runId: string } {
  const { tenantId, credentialRef } = body ?? {};
  if (typeof tenantId !== 'string' || !UUID.test(tenantId)) throw new BadRequestException('tenantId must be a uuid');
  if (typeof credentialRef !== 'string' || !UUID.test(credentialRef)) throw new BadRequestException('credentialRef must be a run id');
  return { tenantId, runId: credentialRef };
}

function actorOf(req: Request) {
  const { userId, tenantId, permissions } = identityOf(req);
  return { userId, tenantId, permissions };
}

async function refusing<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (e instanceof SourceCredentialRefused) throw refusalException(STATUS[e.reason], { reason: e.reason, message: e.message });
    throw e;
  }
}
