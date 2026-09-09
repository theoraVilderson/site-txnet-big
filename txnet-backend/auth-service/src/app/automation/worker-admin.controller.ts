import {
  Body,
  Controller,
  Get,
  Ip,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { PermissionsGuard } from '../impersonation/guards/permissions.guard';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import {
  SetScheduleInput,
  ToggleWorkerInput,
  setScheduleSchema,
  toggleWorkerSchema,
} from './worker-admin.schema';
import { WorkerAdminService, WorkerView } from './worker-admin.service';

/**
 * The admin surface over the background workers (F-031-b).
 *
 * Until now a `bot_schedule` row could only be written by hand with a SQL
 * client, which is why invariant #2's malformed row was both reachable and
 * unreportable. These five routes are the whole registry an operator needs:
 * see what exists and when it last ran, give a worker a schedule, switch a
 * schedule or the worker itself off, and run one now.
 *
 * **Not tenant-scoped, and that is not an omission.** `bot_worker` and
 * `bot_schedule` carry no `tenantId` — a worker is a platform-wide process,
 * not a reseller's — so there is no row here for one tenant's admin to reach
 * into another's. The permission is what confines the surface, and the audit
 * row on the switch is what makes it reviewable.
 */
@Controller('admin/workers')
@UseGuards(AuthGuard, new PermissionsGuard(['worker.manage']))
export class WorkerAdminController {
  constructor(private readonly workers: WorkerAdminService) {}

  /** Every registered worker, its schedules and its most recent run. */
  @Get()
  async list(): Promise<WorkerView[]> {
    return this.workers.list();
  }

  /** Give a worker a schedule. A shape that could never run is refused here. */
  @Post(':key/schedules')
  @UsePipes(new ZodValidationPipe(setScheduleSchema))
  async setSchedule(
    @Req() req: { user?: { sub?: string } },
    @Param('key') key: string,
    @Body() body: SetScheduleInput,
  ) {
    return this.workers.setSchedule(
      key,
      {
        scheduleType: body.scheduleType,
        windowStartAt: body.windowStartAt ?? null,
        windowEndAt: body.windowEndAt ?? null,
        cronExpression: body.cronExpression ?? null,
        timezone: body.timezone,
      },
      req.user?.sub as string,
    );
  }

  /** Switch one schedule on or off. Nothing is ever deleted — see the service. */
  @Patch(':key/schedules/:scheduleId')
  @UsePipes(new ZodValidationPipe(toggleWorkerSchema))
  async toggleSchedule(
    @Param('key') key: string,
    @Param('scheduleId') scheduleId: string,
    @Body() body: ToggleWorkerInput,
  ) {
    return this.workers.toggleSchedule(key, scheduleId, body.isActive);
  }

  /** The kill switch (invariant #1), audited as `bot_toggle`. */
  @Patch(':key')
  @UsePipes(new ZodValidationPipe(toggleWorkerSchema))
  async toggle(
    @Req() req: { user?: { sub?: string } },
    @Param('key') key: string,
    @Body() body: ToggleWorkerInput,
    @Ip() ip: string,
  ) {
    return this.workers.toggle(
      key,
      body.isActive,
      req.user?.sub as string,
      ip,
    );
  }

  /**
   * Run this worker now. Publishes an `admin_manual` tick; the run itself
   * happens in `worker-service`, so a 200 here means "asked for", never
   * "finished" — the outcome arrives as a `bot_execution_log` row.
   */
  @Post(':key/run')
  async runNow(@Param('key') key: string) {
    return this.workers.runNow(key);
  }
}
