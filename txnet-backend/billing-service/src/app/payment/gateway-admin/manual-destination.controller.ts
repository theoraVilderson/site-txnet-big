import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Ip, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

import { identityOf } from '../../request/identity.middleware';
import { RateLimit } from '../../request/rate-limit';
import { ZodValidationPipe } from '../../request/zod-validation.pipe';
import { gatewaySource, refusing } from './gateway-admin.http';
import { GATEWAY_ADMIN_READ as READ, GATEWAY_ADMIN_WRITE as WRITE } from './gateway-admin.rate-limit';
import { CreateDestinationBody, UpdateDestinationBody, createDestinationSchema, updateDestinationSchema } from './gateway-admin.schema';
import { GatewayPermissionGuard } from './gateway-permission.guard';
import { ManualDestinationService } from './manual-destination.service';
import { ResellerGatewayService } from './reseller-gateway.service';

/** `fields` and `label` are required by the schema; the cast is for this project's non-strict tsconfig, as on gateway create. */
type CreateDestination = CreateDestinationBody & { label: string };

/**
 * A manual gateway's destinations on the ambient surface (F-803-c):
 * `/api/billing/gateways/:source/:id/destinations`. Same door, budgets and
 * refusals as the gateway it belongs to (`GatewayAdminController`).
 */
@Controller('billing/gateways/:source/:id/destinations')
@UseGuards(GatewayPermissionGuard)
export class ManualDestinationController {
  constructor(private readonly destinations: ManualDestinationService) {}

  @Get()
  @RateLimit(READ)
  list(@Param('source') source: string, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request, @Ip() ip: string) {
    return refusing(() => this.destinations.list(actorOf(req, ip), { source: gatewaySource(source), id }));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE)
  create(
    @Param('source') source: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(createDestinationSchema)) body: CreateDestinationBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return refusing(() => this.destinations.create(actorOf(req, ip), { source: gatewaySource(source), id }, body as CreateDestination));
  }

  @Patch(':destinationId')
  @RateLimit(WRITE)
  update(
    @Param('source') source: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('destinationId', new ParseUUIDPipe()) destinationId: string,
    @Body(new ZodValidationPipe(updateDestinationSchema)) body: UpdateDestinationBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return refusing(() => this.destinations.update(actorOf(req, ip), { source: gatewaySource(source), id }, destinationId, body));
  }

  @Delete(':destinationId')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE)
  remove(
    @Param('source') source: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('destinationId', new ParseUUIDPipe()) destinationId: string,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return refusing(() => this.destinations.remove(actorOf(req, ip), { source: gatewaySource(source), id }, destinationId));
  }
}

/**
 * The same routes for the reseller the path names (F-066-w3, ADR-0064):
 * `/api/billing/tenants/:tenantId/gateways/:source/:id/destinations`.
 * `ResellerGatewayService.run` is the door — `read` to list, `staffWrite` to
 * write — and the work runs as the reseller, so nothing here is elevated.
 */
@Controller('billing/tenants/:tenantId/gateways/:source/:id/destinations')
export class ResellerManualDestinationController {
  constructor(
    private readonly resellers: ResellerGatewayService,
    private readonly destinations: ManualDestinationService,
  ) {}

  @Get()
  @RateLimit(READ)
  list(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('source') source: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    const ref = { source: gatewaySource(source), id };
    return refusing(() => this.resellers.run(resellerOf(req, ip), tenantId, 'read', (as) => this.destinations.list(as, ref)));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit(WRITE)
  create(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('source') source: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(createDestinationSchema)) body: CreateDestinationBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    const ref = { source: gatewaySource(source), id };
    return refusing(() => this.resellers.run(resellerOf(req, ip), tenantId, 'staffWrite', (as) => this.destinations.create(as, ref, body as CreateDestination)));
  }

  @Patch(':destinationId')
  @RateLimit(WRITE)
  update(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('source') source: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('destinationId', new ParseUUIDPipe()) destinationId: string,
    @Body(new ZodValidationPipe(updateDestinationSchema)) body: UpdateDestinationBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    const ref = { source: gatewaySource(source), id };
    return refusing(() => this.resellers.run(resellerOf(req, ip), tenantId, 'staffWrite', (as) => this.destinations.update(as, ref, destinationId, body)));
  }

  @Delete(':destinationId')
  @HttpCode(HttpStatus.OK)
  @RateLimit(WRITE)
  remove(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('source') source: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('destinationId', new ParseUUIDPipe()) destinationId: string,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    const ref = { source: gatewaySource(source), id };
    return refusing(() => this.resellers.run(resellerOf(req, ip), tenantId, 'staffWrite', (as) => this.destinations.remove(as, ref, destinationId)));
  }
}

/** The ambient caller, as the gate proved them. */
function actorOf(req: Request, ip: string) {
  const { userId, tenantId, permissions } = identityOf(req);
  return { adminId: userId, tenantId, ip, permissions };
}

/** The caller on the named-reseller surface; the reseller is the path's, admitted by `run`. */
function resellerOf(req: Request, ip: string) {
  const { userId, tenantId, permissions } = identityOf(req);
  return { userId, tenantId, permissions, ip };
}
