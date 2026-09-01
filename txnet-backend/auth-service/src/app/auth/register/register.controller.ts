import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
  Req,
  Res,
  UsePipes,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { RegisterService } from './register.service';
import { AuthService } from '../auth.service';
import { registerSchema, verifyPhoneSchema } from './register.schema';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { ResponseType } from '../../common/response/response.util';
import { RateLimit } from '../decorators/rate-limit.decorator';

@Controller('auth')
export class RegisterController {
  constructor(
    private readonly registerService: RegisterService,
    private readonly authService: AuthService,
  ) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ZodValidationPipe(registerSchema))
  @RateLimit({
    key: (req) => `register:${req.ip}`,
    limit: 10,
    windowSec: 3600,
  })
  register(
    @Body() body: ReturnType<typeof registerSchema.parse>,
    @Ip() ip: string,
    @Req() req: Request,
  ) {
    const lang = (req as any).language ?? 'fa';
    return this.registerService.register(body, ip, lang);
  }

  @Post('register/verify-phone')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(verifyPhoneSchema))
  @RateLimit({
    key: (req) => `register:verify:${req.ip}`,
    limit: 20,
    windowSec: 3600,
  })
  async verifyPhone(
    @Body() body: ReturnType<typeof verifyPhoneSchema.parse>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.registerService.verifyPhone(body);
    if (result.ok) {
      const user = await this.authService.findUserForSession(body.userId);
      const tokens = await this.authService.createSessionForUser(
        user,
        req.ip ?? '0.0.0.0',
        req.get('user-agent') ?? 'unknown',
      );
      const { refreshToken, ...safeTokens } = tokens;
      res.cookie('refresh_token', refreshToken, {
        httpOnly: true,
        secure: process.env.COOKIE_SECURE !== 'false',
        sameSite: 'lax',
        path: '/api/auth',
        maxAge: 30 * 24 * 60 * 60 * 1000,
      });
      result.data = { ...result.data, ...safeTokens };
    }
    return result;
  }
}
