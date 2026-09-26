import {
  BadGatewayException,
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  ConflictException,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  Delete,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { holdsPermission, RateLimitBucket, rateLimitBucketKey } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';
import { RateLimit } from '../request/rate-limit';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { PanelCredentialRefused, PanelCredentialUnavailable } from './panel-credential.client';
import { PanelRegistrationService, PanelResubmitRefused, RegisterPanelInput } from './panel-registration';
import { PanelGroupInput, PanelGroupMemberInput, PanelGroupsService } from './panel-groups';
import { PanelInboundsInput, PanelInboundsService } from './panel-inbounds';
import { PanelLifecycleService, PanelSettingsInput } from './panel-lifecycle';
import {
  AcknowledgeDriftBody,
  AddPanelGroupMemberBody,
  addPanelGroupMemberSchema,
  CreatePanelGroupBody,
  createPanelGroupSchema,
  UpdatePanelGroupBody,
  updatePanelGroupSchema,
  UpdatePanelBody,
  updatePanelSchema,
  UpdatePanelInboundsBody,
  updatePanelInboundsSchema,
  acknowledgeDriftSchema,
  DriftEventQueryInput,
  driftEventQuerySchema,
  HoldQueueQueryInput,
  holdQueueQuerySchema,
  RegisterPanelBody,
  registerPanelSchema,
  ResubmitCredentialsBody,
  resubmitRadiusSecretSchema,
  ResubmitRadiusSecretBody,
  resubmitCredentialsSchema,
  ReleaseHoldBody,
  releaseHoldSchema,
  WriteOffHoldBody,
  writeOffHoldSchema,
} from './panel-registration.schema';
import { PanelScopeRefused, SystemsActor } from './panel-scope';
import { PanelAlreadyRegistered } from './panel-address';
import { SystemsReadService, SystemsRefused, SystemsRejection } from './systems-read';
import { UsageHoldsService } from './usage-holds';

/** The permission the systems surface needs (F-027-ar). SuperAdmin holds it as `*`. */
export const PANEL_MANAGE = 'panel.manage';

/**
 * The first door, like `GatewayPermissionGuard`, and like it **not the
 * boundary**: `PanelRegistrationService` admits the platform owner only.
 */
@Injectable()
export class PanelPermissionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (!holdsPermission(identityOf(req).permissions, PANEL_MANAGE)) {
      throw new ForbiddenException(`${PANEL_MANAGE} is required`);
    }
    return true;
  }
}

const SYSTEMS_ADMIN_WRITE = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.SYSTEMS_ADMIN_WRITE, identityOf(req).userId),
  configKey: 'SYSTEMS_ADMIN_WRITE_RATE_LIMIT' as const,
  windowSec: 900,
};

const SYSTEMS_ADMIN_READ = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.SYSTEMS_ADMIN_READ, identityOf(req).userId),
  configKey: 'SYSTEMS_ADMIN_READ_RATE_LIMIT' as const,
  windowSec: 900,
};

/** The refusals that are a state already reached, not something absent: 409. */
const CONFLICTS: ReadonlySet<SystemsRejection> = new Set([
  'already_acknowledged',
  'already_resolved',
  'already_member',
  'already_draining',
  'member_has_configs',
  'inbound_not_sellable',
  'not_for_transport',
  'panel_already_registered',
  'not_for_driver',
  'panel_in_group',
  'panel_has_configs',
  'panel_retired',
  'panel_not_retired',
  'group_has_members',
  'group_in_use',
]);

/** The service's refusals as HTTP: the scope is a 403, a panel, group or event outside it a 404. */
async function refusing<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (e instanceof PanelScopeRefused) throw new ForbiddenException({ reason: e.reason, message: e.message });
    if (e instanceof SystemsRefused) {
      if (e instanceof PanelAlreadyRegistered) throw new ConflictException({ reason: e.reason, message: e.message, panel: e.panel });
      if (CONFLICTS.has(e.reason)) throw new ConflictException({ reason: e.reason, message: e.message });
      throw new NotFoundException({ reason: e.reason, message: e.message });
    }
    throw e;
  }
}

/**
 * The platform owner's systems surface (F-027-ar, ADR-0080): `/api/billing/systems`.
 *
 * `POST panels` registers a panel as desired state and answers `201` with
 * `reviewState: pending` — the verdict arrives on `network-service`'s next
 * tick, not in this response. The login goes in and never comes out:
 * `credentials` is `{configured, version, rotatedAt}`.
 *
 * The reads (F-027-as) are what `network-service`'s loops last wrote: the
 * panel list with health and budget, one panel's capability matrix, and the
 * drift report. Acknowledging a drift event is the one write among them, and
 * it resumes a halted panel's collection on the next pass.
 *
 * The holds queue (F-027-at) lists what the meter held, and ends a hold one
 * of two ways: a release is queued for the meter (`202`, the hold stays
 * `pending` until it is billed), a write-off is recorded here and never
 * charged (ADR-0080 decision 3).
 *
 * Panel groups (F-027-bw) are where a `network_access` variant's Grants are
 * placed: the platform's groups, their members, and draining one — desired
 * state, read by fulfilment and the drain sweep on their next tick.
 *
 * A panel's inbounds (F-114-b) are what `network-service` last read from it,
 * and the admin's pick of which ones a buyer is placed on — `refresh` asks the
 * next pass to read them again (`202`).
 *
 * Who the caller is comes from the gate (`X-User-Id`, `X-Tenant-Id`), never
 * from the body.
 */
@Controller('billing/systems')
@UseGuards(PanelPermissionGuard)
export class SystemsController {
  constructor(
    private readonly registration: PanelRegistrationService,
    private readonly reads: SystemsReadService,
    private readonly holdsQueue: UsageHoldsService,
    private readonly panelGroups: PanelGroupsService,
    private readonly panelInbounds: PanelInboundsService,
    private readonly lifecycle: PanelLifecycleService,
  ) {}

  @Get('panel-groups')
  @RateLimit(SYSTEMS_ADMIN_READ)
  groups(@Req() req: Request) {
    return refusing(() => this.panelGroups.groups(actorOf(req)));
  }

  @Post('panel-groups')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(SYSTEMS_ADMIN_WRITE)
  createGroup(@Body(new ZodValidationPipe(createPanelGroupSchema)) body: CreatePanelGroupBody, @Req() req: Request) {
    // `name` is required by the schema; the cast is for the non-strict tsconfig, as in `register`.
    return refusing(() => this.panelGroups.create(actorOf(req), body as PanelGroupInput & { name: string }));
  }

  @Patch('panel-groups/:id')
  @RateLimit(SYSTEMS_ADMIN_WRITE)
  updateGroup(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updatePanelGroupSchema)) body: UpdatePanelGroupBody,
    @Req() req: Request,
  ) {
    return refusing(() => this.panelGroups.update(actorOf(req), id, body));
  }

  /** Delete a group (F-027-ca). 409 `group_has_members` / `group_in_use` while it has members or a variant names it. */
  @Delete('panel-groups/:id')
  @RateLimit(SYSTEMS_ADMIN_WRITE)
  removeGroup(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return refusing(() => this.panelGroups.remove(actorOf(req), id));
  }

  @Post('panel-groups/:id/members')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(SYSTEMS_ADMIN_WRITE)
  addMember(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(addPanelGroupMemberSchema)) body: AddPanelGroupMemberBody,
    @Req() req: Request,
  ) {
    return refusing(() => this.panelGroups.addMember(actorOf(req), id, body as PanelGroupMemberInput));
  }

  /** `409 member_has_configs` while a live config of the group's Grants is on it: drain it instead. */
  @Delete('panel-groups/:id/members/:panelId')
  @RateLimit(SYSTEMS_ADMIN_WRITE)
  removeMember(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('panelId', new ParseUUIDPipe()) panelId: string,
    @Req() req: Request,
  ) {
    return refusing(() => this.panelGroups.removeMember(actorOf(req), id, panelId));
  }

  /** `200` the member, `drain`, with `drainingSince` and the least `waitSeconds` before its configs go. */
  @Post('panel-groups/:id/members/:panelId/drain')
  @HttpCode(HttpStatus.OK)
  @RateLimit(SYSTEMS_ADMIN_WRITE)
  drainMember(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('panelId', new ParseUUIDPipe()) panelId: string,
    @Req() req: Request,
  ) {
    return refusing(() => this.panelGroups.drain(actorOf(req), id, panelId));
  }

  @Get('panels')
  @RateLimit(SYSTEMS_ADMIN_READ)
  panels(@Req() req: Request) {
    return refusing(() => this.reads.panels(actorOf(req)));
  }

  /**
   * Edit a panel's settings (F-027-by). `200 {id, reviewState, retest}`:
   * `retest` is whether a changed address sent it back to `pending`.
   */
  @Patch('panels/:id')
  @RateLimit(SYSTEMS_ADMIN_WRITE)
  updatePanel(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updatePanelSchema)) body: UpdatePanelBody,
    @Req() req: Request,
  ) {
    return refusing(() => this.lifecycle.update(actorOf(req), id, body as PanelSettingsInput));
  }

  /**
   * Delete a panel (F-027-bz). `200 {id, outcome}`: `deleted` when it had no
   * history, `archived` when it had. 409 while a group holds it or a config
   * on it is live.
   */
  @Delete('panels/:id')
  @RateLimit(SYSTEMS_ADMIN_WRITE)
  removePanel(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return refusing(() => this.lifecycle.remove(actorOf(req), id));
  }

  /** Restore an archived panel (F-027-bz). `200 {id, reviewState: 'pending'}`: it is re-tested first. */
  @Post('panels/:id/restore')
  @HttpCode(HttpStatus.OK)
  @RateLimit(SYSTEMS_ADMIN_WRITE)
  restorePanel(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return refusing(() => this.lifecycle.restore(actorOf(req), id));
  }

  @Get('panels/:id/capabilities')
  @RateLimit(SYSTEMS_ADMIN_READ)
  capabilities(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return refusing(() => this.reads.capabilities(actorOf(req), id));
  }

  @Get('panels/:id/inbounds')
  @RateLimit(SYSTEMS_ADMIN_READ)
  inbounds(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return refusing(() => this.panelInbounds.inbounds(actorOf(req), id));
  }

  @Put('panels/:id/inbounds')
  @RateLimit(SYSTEMS_ADMIN_WRITE)
  updateInbounds(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updatePanelInboundsSchema)) body: UpdatePanelInboundsBody,
    @Req() req: Request,
  ) {
    return refusing(() => this.panelInbounds.update(actorOf(req), id, body as PanelInboundsInput));
  }

  @Post('panels/:id/inbounds/refresh')
  @HttpCode(HttpStatus.ACCEPTED)
  @RateLimit(SYSTEMS_ADMIN_WRITE)
  refreshInbounds(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return refusing(() => this.panelInbounds.refresh(actorOf(req), id));
  }

  @Get('drift-events')
  @RateLimit(SYSTEMS_ADMIN_READ)
  driftEvents(@Query(new ZodValidationPipe(driftEventQuerySchema)) query: DriftEventQueryInput, @Req() req: Request) {
    return refusing(() => this.reads.driftEvents(actorOf(req), query));
  }

  @Post('drift-events/:id/acknowledge')
  @HttpCode(HttpStatus.OK)
  @RateLimit(SYSTEMS_ADMIN_WRITE)
  acknowledge(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(acknowledgeDriftSchema)) body: AcknowledgeDriftBody,
    @Req() req: Request,
  ) {
    return refusing(() => this.reads.acknowledge(actorOf(req), id, body));
  }

  @Get('holds')
  @RateLimit(SYSTEMS_ADMIN_READ)
  holds(@Query(new ZodValidationPipe(holdQueueQuerySchema)) query: HoldQueueQueryInput, @Req() req: Request) {
    return refusing(() => this.holdsQueue.holds(actorOf(req), query));
  }

  @Post('holds/:id/release')
  @HttpCode(HttpStatus.ACCEPTED)
  @RateLimit(SYSTEMS_ADMIN_WRITE)
  release(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(releaseHoldSchema)) body: ReleaseHoldBody,
    @Req() req: Request,
  ) {
    return refusing(() => this.holdsQueue.release(actorOf(req), id, body));
  }

  @Post('holds/:id/write-off')
  @HttpCode(HttpStatus.OK)
  @RateLimit(SYSTEMS_ADMIN_WRITE)
  writeOff(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(writeOffHoldSchema)) body: WriteOffHoldBody,
    @Req() req: Request,
  ) {
    // Required by the schema; the cast is for the non-strict tsconfig, as in `register`.
    return refusing(() => this.holdsQueue.writeOff(actorOf(req), id, body as { note: string }));
  }

  @Post('panels')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(SYSTEMS_ADMIN_WRITE)
  async register(@Body(new ZodValidationPipe(registerPanelSchema)) body: RegisterPanelBody, @Req() req: Request) {
    const { userId, tenantId } = identityOf(req);
    // The schema requires every field; the cast is for this project's
    // non-strict tsconfig, under which zod infers every key as optional.
    return relayingVault(() => this.registration.register({ adminId: userId, tenantId }, body as RegisterPanelInput));
  }

  /**
   * Re-submit a panel's login (F-027-au). `200 {id, reviewState, retest,
   * credentials}`: `retest` is whether the next tick tests it again — only a
   * `pending` panel not cooling off after `rate_limited`. A refused panel is
   * 409 `panel_refused`.
   */
  @Put('panels/:id/credentials')
  @RateLimit(SYSTEMS_ADMIN_WRITE)
  resubmitCredentials(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(resubmitCredentialsSchema)) body: ResubmitCredentialsBody,
    @Req() req: Request,
  ) {
    return relayingVault(() =>
      refusing(() => this.registration.resubmitCredentials(actorOf(req), id, body.credentials as string)),
    );
  }

  /**
   * Re-submit a push panel's RADIUS secret (F-027-az). `200 {id, reviewState,
   * radiusSecret}`; nothing is re-tested. A pull panel is 409
   * `panel_not_push`, a refused one 409 `panel_refused`.
   */
  @Put('panels/:id/radius-secret')
  @RateLimit(SYSTEMS_ADMIN_WRITE)
  resubmitRadiusSecret(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(resubmitRadiusSecretSchema)) body: ResubmitRadiusSecretBody,
    @Req() req: Request,
  ) {
    return relayingVault(() =>
      refusing(() => this.registration.resubmitRadiusSecret(actorOf(req), id, body.radiusSecret as string)),
    );
  }
}

/** The routes that write a login or a secret: the scope as 403, the vault seam's refusals relayed, its silence a 502. */
async function relayingVault<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (e instanceof PanelScopeRefused) throw new ForbiddenException({ reason: e.reason, message: e.message });
    if (e instanceof PanelResubmitRefused) throw new ConflictException({ reason: e.reason, message: e.message });
    if (e instanceof PanelCredentialRefused) throw new HttpException({ reason: e.reason, message: e.message }, e.status);
    if (e instanceof PanelCredentialUnavailable) {
      throw new BadGatewayException({ reason: 'credentials_unavailable', message: 'the credential vault could not be reached' });
    }
    throw e;
  }
}

function actorOf(req: Request): SystemsActor {
  const { userId, tenantId } = identityOf(req);
  return { adminId: userId, tenantId };
}
