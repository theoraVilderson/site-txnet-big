import {
  RateLimitBucket,
  rateLimitBucketKey,
} from '@txnet-backend/shared-core';
import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { ok, err } from '../../common/response/response.util';
import { RateLimit } from '../decorators/rate-limit.decorator';
import { rateLimitSubject } from '../../common/security/service-caller';
import { BotLinkService } from './bot-link.service';
import {
  botLinkContactSchema,
  botLinkResolveSchema,
  botLinkStatusSchema,
  botSessionSchema,
  botWebAppSessionSchema,
} from './bot-link.schema';
import { BotSessionService } from './bot-session.service';
import { ServiceOnlyGuard } from '../../common/guards/service-only.guard';
import { withRefreshCookie } from '../../common/http/refresh-cookie';

/**
 * The bot side of account linking.
 *
 * The webhook is public by necessity — Telegram and Bale call it from their
 * own infrastructure — so the shared secret sits in the path, and Telegram's
 * `X-Telegram-Bot-Api-Secret-Token` header is checked as well when it sends
 * one. An unauthenticated or unknown call is a 404: a webhook URL that
 * answers differently for a wrong secret is a webhook URL that can be probed.
 */
@Controller('auth/bots')
export class BotLinkController {
  constructor(
    private readonly links: BotLinkService,
    private readonly sessions: BotSessionService,
  ) {}

  /**
   * `bot-service` handing over a `/start` it received (ADR-0011). It parsed the
   * payload and resolved which bot the update belongs to; the decision — ask
   * for a contact, or send the code — is made here, because the rule is
   * `identity`'s and exists once.
   */
  @Post('link/resolve')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ServiceOnlyGuard)
  @UsePipes(new ZodValidationPipe(botLinkResolveSchema))
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.BOT_LINK_RESOLVE, req.body?.chatId ?? rateLimitSubject(req)),
    configKey: 'BOT_LINK_RESOLVE_RATE_LIMIT',
    windowSec: 60,
  })
  async resolve(@Body() body: any) {
    return ok(
      await this.links.resolveStart(
        body.platform,
        body.chatId,
        body.startToken,
        body.languageCode,
      ),
      'auth.botLinkResolved',
    );
  }

  /**
   * The shared contact, forwarded verbatim. The `contact.user_id === senderId`
   * check that makes it proof (invariant #12) happens in `BotLinkService` and
   * nowhere else — `bot-service` only renders what comes back.
   */
  @Post('link/contact')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ServiceOnlyGuard)
  @UsePipes(new ZodValidationPipe(botLinkContactSchema))
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.BOT_LINK_CONTACT, req.body?.chatId ?? rateLimitSubject(req)),
    configKey: 'BOT_LINK_CONTACT_RATE_LIMIT',
    windowSec: 300,
  })
  async contact(@Body() body: any) {
    return ok(
      await this.links.submitContact(
        body.platform,
        body.chatId,
        body.senderId,
        body.contact,
      ),
      'auth.botLinkContact',
    );
  }

  /**
   * Signing in as the messenger account itself (ADR-0012).
   *
   * A contact-verified `LinkedBotAccount` is a credential, not a step towards
   * one, so a chat holding it gets the ordinary token pair — the same session,
   * the same rotation, the same revocation as a password login. The one-time
   * code that used to follow the link re-delivered a proof this service
   * already held, into the chat that asked for it.
   *
   * A chat with no link may send a contact card with the request and be linked
   * on the spot: unlike `link/contact`, no phone number was typed beforehand,
   * because the card carries one the platform vouches for. The ownership proof
   * is unchanged (invariant #12) — only which end is known first.
   */
  @Post('session')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ServiceOnlyGuard)
  @UsePipes(new ZodValidationPipe(botSessionSchema))
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.BOT_SESSION, req.body?.chatId ?? rateLimitSubject(req)),
    configKey: 'BOT_SESSION_RATE_LIMIT',
    windowSec: 300,
  })
  async session(@Body() body: any, @Req() req: Request) {
    const outcome = await this.sessions.authenticate(
      body,
      // Nothing observed (F-048). `req.ip` here is `bot-service`'s container
      // and the user agent is its HTTP client — neither says anything about
      // the person, and both are identical for every chat on the platform.
      // The session is labelled with the messenger instead.
      null,
    );
    if (outcome.state === 'refused') {
      return err(outcome.key);
    }
    return ok(outcome, 'auth.botSession');
  }

  /**
   * The same sign-in, from inside the Mini App (`F-310`, ADR-0018).
   *
   * Unlike every other route on this controller this one is **public**, and
   * that is the point rather than an oversight: the caller is a browser in a
   * messenger's webview, it holds no service token, and what it presents
   * instead is a string the platform signed with the bot's own token. The
   * signature *is* the authentication, so a `ServiceOnlyGuard` here would only
   * be asking a browser for a secret no browser can keep.
   *
   * It answers like a browser login, not like the bot route: the refresh token
   * goes into the httpOnly cookie and never into a body a script can read.
   */
  @Post('webapp/session')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(botWebAppSessionSchema))
  // Per-IP, unlike the chat routes: real browsers call this one, and the only
  // chat id available before verification is one an attacker chose.
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.BOT_WEBAPP_SESSION, rateLimitSubject(req)),
    configKey: 'BOT_WEBAPP_SESSION_RATE_LIMIT',
    windowSec: 900,
  })
  async webAppSession(
    @Body() body: any,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const outcome = await this.sessions.authenticateWebApp(body, {
      // The one messenger route where a device really is on the line: a
      // webview is a browser, so its IP and user agent are the user's.
      ip: req.ip ?? '',
      userAgent: req.get('user-agent') ?? 'unknown',
    });
    if (outcome.state === 'refused') {
      return err(outcome.key);
    }
    if (outcome.state === 'needsContact') {
      // Not an error, and not something this surface can fix: the Mini App
      // cannot ask for a contact card. The chat can, and already does.
      return ok(outcome, 'auth.botSession');
    }
    // The browser's token shape, not the bot's: `{accessToken, expiresIn}` in
    // `data` with the refresh half in the cookie, exactly as a password login
    // answers. The caller here is `panel-web`, and it already reads that shape
    // everywhere else.
    return withRefreshCookie(
      res,
      ok({ state: outcome.state, ...outcome.tokens }, 'auth.botSession'),
    );
  }

  /**
   * "Has the user finished in the messenger yet?" — polled by the screen that
   * is showing the deep link.
   */
  @Post('link/status')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(botLinkStatusSchema))
  // Generous on purpose: the screen polls every 2.5s for as long as the user
  // is in the messenger, and each call is one Redis read.
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.BOT_LINK_STATUS, rateLimitSubject(req)),
    configKey: 'BOT_LINK_STATUS_RATE_LIMIT',
    windowSec: 900,
  })
  async status(@Body() body: { linkToken: string }) {
    return ok(await this.links.status(body.linkToken), 'auth.botLinkStatus');
  }

}
