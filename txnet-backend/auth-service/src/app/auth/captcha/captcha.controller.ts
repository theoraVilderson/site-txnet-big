import { Body, Controller, HttpCode, HttpStatus, Post, UsePipes } from '@nestjs/common';
import { CaptchaService } from './captcha.service';
import { captchaVerifySchema } from './captcha.schema';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { ok, err } from '../../common/response/response.util';
import { RateLimit } from '../decorators/rate-limit.decorator';

@Controller('auth/captcha')
export class CaptchaController {
  constructor(private readonly captcha: CaptchaService) {}

  @Post('challenge')
  @HttpCode(HttpStatus.OK)
  @RateLimit({
    key: (req) => `captcha:challenge:${req.ip}`,
    limit: 30,
    windowSec: 900,
  })
  async challenge() {
    return ok(await this.captcha.issueChallenge());
  }

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(captchaVerifySchema))
  @RateLimit({
    key: (req) => `captcha:verify:${req.ip}`,
    limit: 30,
    windowSec: 900,
  })
  async verify(@Body() body: ReturnType<typeof captchaVerifySchema.parse>) {
    const result = await this.captcha.verifyChallenge(body.challengeId);
    if (!result) return err('captcha.invalid');
    return ok(result);
  }
}
