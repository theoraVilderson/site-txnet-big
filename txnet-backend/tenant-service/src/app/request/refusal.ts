import { BadRequestException, ConflictException, ForbiddenException, HttpException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';

/** The statuses a refusal is answered with, as a controller's `STATUS` record names them. */
export type RefusalStatus = 400 | 403 | 404 | 409 | 422;

/** A refusal's answer: its reason and the message naming the rule, never a value. */
export type RefusalPayload = { reason: string; message: string };

const EXCEPTION: Record<RefusalStatus, new (payload: RefusalPayload) => HttpException> = {
  400: BadRequestException,
  403: ForbiddenException,
  404: NotFoundException,
  409: ConflictException,
  422: UnprocessableEntityException,
};

/**
 * The HTTP exception for a refusal at `status` — one home for the switch each
 * controller here wrote out by hand (C-27). A new controller calls this; the
 * older ones move to it when they are next touched.
 */
export function refusalException(status: RefusalStatus, payload: RefusalPayload): HttpException {
  return new EXCEPTION[status](payload);
}
