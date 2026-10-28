import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
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
import { ZodValidationPipe } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { RateLimit } from '../request/rate-limit';
import { SYSTEMS_ADMIN_READ, SYSTEMS_ADMIN_SETTINGS, SYSTEMS_ADMIN_WRITE } from './systems-budgets';
import { PanelRegistrationService, RegisterPanelInput } from './panel-registration';
import { MemberSellingInput, PanelGroupInput, PanelGroupMemberInput, PanelGroupsService } from './panel-groups';
import { PanelInboundsInput, PanelInboundsService } from './panel-inbounds';
import { PanelLifecycleService, PanelSettingsInput } from './panel-lifecycle';
import {
  AcknowledgeDriftBody,
  AddPanelGroupMemberBody,
  addPanelGroupMemberSchema,
  AssignMemberInboundsBody,
  assignMemberInboundsSchema,
  CreatePanelGroupBody,
  EvictPanelGroupMemberBody,
  evictPanelGroupMemberSchema,
  RemovePanelQuery,
  removePanelQuerySchema,
  createPanelGroupSchema,
  UpdatePanelGroupBody,
  updatePanelGroupSchema,
  UpdatePanelGroupMemberBody,
  updatePanelGroupMemberSchema,
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
import { MemberInboundsService } from './member-inbounds';
import { SystemsReadService } from './systems-read';
import { RESELLER_SYSTEMS_PATH, SystemsDoorGuard, systemsActorOf } from './systems-door';
import { refusing, relayingVault } from './systems-refusals';
import { UsageHoldsService } from './usage-holds';

/**
 * The systems surface (F-027-ar, ADR-0080): the owner's at `/api/billing/systems`, and
 * the same routes for a reseller's own panels at `/api/billing/tenants/:tenantId/systems`
 * (ADR-0166) — which door, and whose panels, is `SystemsDoorGuard`'s.
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
@Controller(['billing/systems', RESELLER_SYSTEMS_PATH])
@UseGuards(SystemsDoorGuard)
export class SystemsController {
  constructor(
    private readonly registration: PanelRegistrationService,
    private readonly reads: SystemsReadService,
    private readonly holdsQueue: UsageHoldsService,
    private readonly panelGroups: PanelGroupsService,
    private readonly panelInbounds: PanelInboundsService,
    private readonly lifecycle: PanelLifecycleService,
    private readonly memberInbounds: MemberInboundsService,
  ) {}

  @Get('panel-groups')
  @RateLimit(SYSTEMS_ADMIN_READ)
  groups(@Req() req: Request) {
    return refusing(() => this.panelGroups.groups(systemsActorOf(req)));
  }

  @Post('panel-groups')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(SYSTEMS_ADMIN_SETTINGS)
  createGroup(@Body(new ZodValidationPipe(createPanelGroupSchema)) body: CreatePanelGroupBody, @Req() req: Request) {
    // `name` is required by the schema; the cast is for the non-strict tsconfig, as in `register`.
    return refusing(() => this.panelGroups.create(systemsActorOf(req), body as PanelGroupInput & { name: string }));
  }

  @Patch('panel-groups/:id')
  @RateLimit(SYSTEMS_ADMIN_SETTINGS)
  updateGroup(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updatePanelGroupSchema)) body: UpdatePanelGroupBody,
    @Req() req: Request,
  ) {
    return refusing(() => this.panelGroups.update(systemsActorOf(req), id, body));
  }

  /** Delete a group (F-027-ca). 409 `group_has_members` / `group_in_use` while it has members or a variant names it. */
  @Delete('panel-groups/:id')
  @RateLimit(SYSTEMS_ADMIN_SETTINGS)
  removeGroup(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return refusing(() => this.panelGroups.remove(systemsActorOf(req), id));
  }

  @Post('panel-groups/:id/members')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(SYSTEMS_ADMIN_SETTINGS)
  addMember(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(addPanelGroupMemberSchema)) body: AddPanelGroupMemberBody,
    @Req() req: Request,
  ) {
    return refusing(() => this.panelGroups.addMember(systemsActorOf(req), id, body as PanelGroupMemberInput));
  }

  /**
   * A member's own selling settings (F-027-cg): null inherits the panel's.
   * `200` the member, with `effective` — each value and its layer.
   */
  @Patch('panel-groups/:id/members/:panelId')
  @RateLimit(SYSTEMS_ADMIN_SETTINGS)
  updateMember(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('panelId', new ParseUUIDPipe()) panelId: string,
    @Body(new ZodValidationPipe(updatePanelGroupMemberSchema)) body: UpdatePanelGroupMemberBody,
    @Req() req: Request,
  ) {
    return refusing(() => this.panelGroups.updateMember(systemsActorOf(req), id, panelId, body as MemberSellingInput));
  }

  /**
   * The inbounds this membership lists (F-027-ep), beside the every-group
   * ones: the whole set. `409 inbound_has_configs` names a group that would
   * lose an inbound with live configs there, with the count.
   */
  @Put('panel-groups/:id/members/:panelId/inbounds')
  @RateLimit(SYSTEMS_ADMIN_SETTINGS)
  assignMemberInbounds(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('panelId', new ParseUUIDPipe()) panelId: string,
    @Body(new ZodValidationPipe(assignMemberInboundsSchema)) body: AssignMemberInboundsBody,
    @Req() req: Request,
  ) {
    return refusing(() => this.memberInbounds.assign(systemsActorOf(req), id, panelId, body.inbounds as string[]));
  }

  /** `409 member_has_configs` while a live config of the group's Grants is on it: drain it instead. */
  @Delete('panel-groups/:id/members/:panelId')
  @RateLimit(SYSTEMS_ADMIN_SETTINGS)
  removeMember(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('panelId', new ParseUUIDPipe()) panelId: string,
    @Req() req: Request,
  ) {
    return refusing(() => this.panelGroups.removeMember(systemsActorOf(req), id, panelId));
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
    return refusing(() => this.panelGroups.drain(systemsActorOf(req), id, panelId));
  }

  /** What "remove now" would take: `liveConfigs`, and `soleLineGrants` — active Grants left with no line. */
  @Get('panel-groups/:id/members/:panelId/evict-preview')
  @RateLimit(SYSTEMS_ADMIN_READ)
  evictPreview(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('panelId', new ParseUUIDPipe()) panelId: string,
    @Req() req: Request,
  ) {
    return refusing(() => this.panelGroups.evictPreview(systemsActorOf(req), id, panelId));
  }

  /**
   * `200` the member, `drain` with `evictedAt`: "remove now" for a broken or
   * gone panel (F-027-ee). The drain sweep retires its configs on its next
   * tick with no wait, then removes it. Any member, the group's last included.
   * `orphans` (F-027-eg): `pause` or `refund` the Grants it leaves with no line.
   */
  @Post('panel-groups/:id/members/:panelId/evict')
  @HttpCode(HttpStatus.OK)
  @RateLimit(SYSTEMS_ADMIN_WRITE)
  evictMember(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('panelId', new ParseUUIDPipe()) panelId: string,
    @Body(new ZodValidationPipe(evictPanelGroupMemberSchema)) body: EvictPanelGroupMemberBody,
    @Req() req: Request,
  ) {
    return refusing(() => this.panelGroups.evict(systemsActorOf(req), id, panelId, body.orphans));
  }

  @Get('panels')
  @RateLimit(SYSTEMS_ADMIN_READ)
  panels(@Req() req: Request) {
    return refusing(() => this.reads.panels(systemsActorOf(req)));
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
    return refusing(() => this.lifecycle.update(systemsActorOf(req), id, body as PanelSettingsInput));
  }

  /**
   * Delete a panel (F-027-bz). `200 {id, outcome}`: `deleted` when it had no
   * history, `archived` when it had. 409 while a group holds it or a config
   * on it is live — unless `?orphans=pause|refund` (F-027-eg): then a panel in
   * groups is evicted from every one with that choice, answered `removing`,
   * and archived by the drain sweep once it is empty.
   */
  @Delete('panels/:id')
  @RateLimit(SYSTEMS_ADMIN_WRITE)
  removePanel(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(new ZodValidationPipe(removePanelQuerySchema)) query: RemovePanelQuery,
    @Req() req: Request,
  ) {
    return refusing(() => this.lifecycle.remove(systemsActorOf(req), id, query.orphans));
  }

  /** What deleting it in one step would take: `{groups, liveConfigs, soleLineGrants}`, summed over its groups. */
  @Get('panels/:id/remove-preview')
  @RateLimit(SYSTEMS_ADMIN_READ)
  removePanelPreview(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return refusing(() => this.lifecycle.removePreview(systemsActorOf(req), id));
  }

  /** Restore an archived panel (F-027-bz). `200 {id, reviewState: 'pending'}`: it is re-tested first. */
  @Post('panels/:id/restore')
  @HttpCode(HttpStatus.OK)
  @RateLimit(SYSTEMS_ADMIN_WRITE)
  restorePanel(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return refusing(() => this.lifecycle.restore(systemsActorOf(req), id));
  }

  @Get('panels/:id/capabilities')
  @RateLimit(SYSTEMS_ADMIN_READ)
  capabilities(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return refusing(() => this.reads.capabilities(systemsActorOf(req), id));
  }

  @Get('panels/:id/inbounds')
  @RateLimit(SYSTEMS_ADMIN_READ)
  inbounds(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return refusing(() => this.panelInbounds.inbounds(systemsActorOf(req), id));
  }

  @Put('panels/:id/inbounds')
  @RateLimit(SYSTEMS_ADMIN_SETTINGS)
  updateInbounds(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updatePanelInboundsSchema)) body: UpdatePanelInboundsBody,
    @Req() req: Request,
  ) {
    return refusing(() => this.panelInbounds.update(systemsActorOf(req), id, body as PanelInboundsInput));
  }

  @Post('panels/:id/inbounds/refresh')
  @HttpCode(HttpStatus.ACCEPTED)
  @RateLimit(SYSTEMS_ADMIN_WRITE)
  refreshInbounds(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return refusing(() => this.panelInbounds.refresh(systemsActorOf(req), id));
  }

  @Get('drift-events')
  @RateLimit(SYSTEMS_ADMIN_READ)
  driftEvents(@Query(new ZodValidationPipe(driftEventQuerySchema)) query: DriftEventQueryInput, @Req() req: Request) {
    return refusing(() => this.reads.driftEvents(systemsActorOf(req), query));
  }

  @Post('drift-events/:id/acknowledge')
  @HttpCode(HttpStatus.OK)
  @RateLimit(SYSTEMS_ADMIN_SETTINGS)
  acknowledge(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(acknowledgeDriftSchema)) body: AcknowledgeDriftBody,
    @Req() req: Request,
  ) {
    return refusing(() => this.reads.acknowledge(systemsActorOf(req), id, body));
  }

  @Get('holds')
  @RateLimit(SYSTEMS_ADMIN_READ)
  holds(@Query(new ZodValidationPipe(holdQueueQuerySchema)) query: HoldQueueQueryInput, @Req() req: Request) {
    return refusing(() => this.holdsQueue.holds(systemsActorOf(req), query));
  }

  @Post('holds/:id/release')
  @HttpCode(HttpStatus.ACCEPTED)
  @RateLimit(SYSTEMS_ADMIN_WRITE)
  release(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(releaseHoldSchema)) body: ReleaseHoldBody,
    @Req() req: Request,
  ) {
    return refusing(() => this.holdsQueue.release(systemsActorOf(req), id, body));
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
    return refusing(() => this.holdsQueue.writeOff(systemsActorOf(req), id, body as { note: string }));
  }

  @Post('panels')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(SYSTEMS_ADMIN_WRITE)
  async register(@Body(new ZodValidationPipe(registerPanelSchema)) body: RegisterPanelBody, @Req() req: Request) {
    // The schema requires every field; the cast is for this project's
    // non-strict tsconfig, under which zod infers every key as optional.
    return relayingVault(() => this.registration.register(systemsActorOf(req), body as RegisterPanelInput));
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
      refusing(() => this.registration.resubmitCredentials(systemsActorOf(req), id, body.credentials as string)),
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
      refusing(() => this.registration.resubmitRadiusSecret(systemsActorOf(req), id, body.radiusSecret as string)),
    );
  }
}

