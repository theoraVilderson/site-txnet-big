import { Body, Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { RateLimitBucket, rateLimitBucketKey, ZodValidationPipe } from '@txnet-backend/shared-core';
import type { Request } from 'express';
import { z } from 'zod';

import { identityOf } from '../../request/identity.middleware';
import { RateLimit } from '../../request/rate-limit';
import { refusalException } from '../../request/refusal-exception';
import { DepositProofService, ProofRefused, type ProofRejection } from './deposit-proof.service';

/** Every refusal gets a status; a new reason does not compile until it gets one. */
const STATUS: Record<ProofRejection, 400 | 404 | 409> = {
  transfer_not_found: 404,
  transfer_closed: 409,
  proof_already_sent: 409,
  invalid_proof: 400,
  receipt_missing: 400,
  receipt_rejected: 400,
  duplicate_ref: 409,
};

/** Both routes on one budget: a receipt and its proof are one act of one payer. */
const PROOF = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.DEPOSIT_PROOF, identityOf(req).userId),
  configKey: 'DEPOSIT_PROOF_RATE_LIMIT' as const,
  windowSec: 900,
};

/** An object of the kind's proof fields; each field is the kind's to check (`parseProof`), not a second copy here. */
const proofBodySchema = z.record(z.string(), z.unknown());

/** A multipart file as multer holds it in memory. */
interface UploadedPart {
  mimetype: string;
  buffer: Buffer;
}

/**
 * A manual transfer's proof, from its payer (F-805-a): the receipt as
 * multipart `file`, then the proof by the kind's field ids. Behind the gate
 * like every deposit route; whose payment it is comes from its row, never the
 * body. A refusal names its rule as `reason`, and refused fields as
 * `error.facts` (`{trackingCode: 'invalid'}`), as gateway admin does.
 */
@Controller('billing/deposit')
export class DepositProofController {
  constructor(private readonly proofs: DepositProofService) {}

  @Post(':paymentId/proof/upload')
  @HttpCode(HttpStatus.OK)
  @RateLimit(PROOF)
  @UseInterceptors(FileInterceptor('file'))
  upload(@Param('paymentId', new ParseUUIDPipe()) paymentId: string, @Req() req: Request, @UploadedFile() file: UploadedPart | undefined) {
    if (!file) throw refusalException(400, { reason: 'receipt_rejected', message: 'the receipt arrives as the multipart field `file`' });
    return refusing(() => this.proofs.upload(identityOf(req).userId, paymentId, { contentType: file.mimetype, bytes: file.buffer }));
  }

  @Post(':paymentId/proof')
  @HttpCode(HttpStatus.OK)
  @RateLimit(PROOF)
  submit(@Param('paymentId', new ParseUUIDPipe()) paymentId: string, @Req() req: Request, @Body(new ZodValidationPipe(proofBodySchema)) body: Record<string, unknown>) {
    return refusing(() => this.proofs.submit(identityOf(req).userId, paymentId, body));
  }
}

async function refusing<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (!(e instanceof ProofRefused)) throw e;
    const facts = e.refusals ? Object.fromEntries(e.refusals.map((r) => [r.field, r.reason])) : undefined;
    throw refusalException(STATUS[e.reason], { reason: e.reason, message: e.message, ...(facts ? { facts } : {}) });
  }
}
