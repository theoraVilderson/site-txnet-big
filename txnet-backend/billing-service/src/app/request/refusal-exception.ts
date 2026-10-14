import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

/** A status a refusal may answer with. Each controller maps its own reasons to one, exhaustively. */
export type RefusalStatus = 400 | 403 | 404 | 409 | 503;

/** A refusal as the exception its status answers with; the reason travels in the body for the panel to translate. */
export function refusalException(status: RefusalStatus, payload: { reason: string; message: string }): HttpException {
  switch (status) {
    case 403:
      return new ForbiddenException(payload);
    case 404:
      return new NotFoundException(payload);
    case 409:
      return new ConflictException(payload);
    case 503:
      return new ServiceUnavailableException(payload);
    case 400:
      return new BadRequestException(payload);
  }
}
