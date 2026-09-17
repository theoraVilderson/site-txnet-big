import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OtpChannel, OtpPurpose } from './otp.interface';
import { IOtpSender, OTP_SENDERS } from './senders/otp-sender.interface';
import { BackendI18nKeys } from '@txnet-backend/shared-core';

export interface OtpChannelDescriptor {
  channel: OtpChannel;
  /** The channel can only deliver to a linked, contact-verified messenger. */
  requiresLink: boolean;
}

/**
 * Which OTP channels this environment offers, and the senders behind them.
 *
 * Two gates, both of which must pass:
 *   1. `OTP_ALLOWED_CHANNELS` lists it — the operator's switch. Turning
 *      `sms` off and leaving `telegram,bale` on is a supported deployment.
 *   2. its sender reports itself configured (bot token / SMS credentials).
 *      For the messenger channels that is now a **per-tenant** question — the
 *      token belongs to the tenant's `BotIntegration`, not to the environment
 *      (F-066-i) — which is why gate 2 is asynchronous and why nothing here is
 *      answered at boot.
 *
 * A channel that fails either gate does not exist as far as clients are
 * concerned: it is absent from `GET /auth/otp/channels` and rejected if named
 * explicitly. `OTP_DELIVERY_MODE=console` waives gate 2 only — a channel still
 * has to be allowed — so dev environments can exercise every path.
 */
@Injectable()
export class OtpChannelRegistry {
  private readonly logger = new Logger(OtpChannelRegistry.name);
  private readonly senders: Map<OtpChannel, IOtpSender>;
  private readonly allowedChannels: OtpChannel[];
  private readonly consoleOnly: boolean;

  constructor(
    config: ConfigService,
    // The set, not three by name: every sender declares its own `channel`, so
    // the registry never has to be edited to learn about a new one. See
    // `OTP_SENDERS` — `auth.module.ts` is the only place the classes appear.
    @Inject(OTP_SENDERS) senders: IOtpSender[],
  ) {
    this.senders = new Map<OtpChannel, IOtpSender>(
      senders.map((s) => [s.channel, s]),
    );

    const raw = config.get<string[] | string>('OTP_ALLOWED_CHANNELS', ['sms']);
    const names = (
      Array.isArray(raw) ? raw : String(raw).split(',')
    ).map((c) => c.trim());

    // A channel reserved to one purpose is never a login channel, so listing
    // it here allows nothing (F-035-g).
    this.allowedChannels = names.filter(
      (name): name is OtpChannel =>
        this.senders.has(name as OtpChannel) &&
        !this.senders.get(name as OtpChannel)!.onlyFor,
    );
    const unknown = names.filter(
      (name) => name && !this.senders.has(name as OtpChannel),
    );
    if (unknown.length) {
      this.logger.warn(
        `OTP_ALLOWED_CHANNELS names unknown channel(s): ${unknown.join(', ')}`,
      );
    }

    this.consoleOnly =
      config.get<string>('OTP_DELIVERY_MODE', 'live') === 'console' ||
      config.get<boolean>('OTP_DEV_CONSOLE_LOG', false);

    // Allowed, not available: availability now depends on which tenant is
    // asking, and no tenant is in scope at boot.
    this.logger.log(
      `OTP channels allowed=[${this.allowedChannels.join(',')}]` +
        (this.consoleOnly ? ' (console delivery — nothing is really sent)' : ''),
    );
  }

  sender(channel: OtpChannel): IOtpSender | undefined {
    return this.senders.get(channel);
  }

  /** Delivery is faked, so no sender is actually called. */
  isConsoleOnly(): boolean {
    return this.consoleOnly;
  }

  isAllowed(channel: OtpChannel): boolean {
    return this.allowedChannels.includes(channel);
  }

  /**
   * @param to the destination, when the question is about one. SMS under a
   * reseller depends on it (F-018-b, D-41); with none, the answer is the one
   * an anonymous caller gets.
   */
  async isAvailable(channel: OtpChannel, to?: string): Promise<boolean> {
    if (!this.isAllowed(channel)) return false;
    if (this.consoleOnly) return true;
    return (await this.senders.get(channel)?.isConfigured(to)) ?? false;
  }

  requiresLink(channel: OtpChannel): boolean {
    return this.senders.get(channel)?.requiresLinkedAccount ?? false;
  }

  /** Every channel a client may ask for right now, for the tenant in scope (and `to`, if known). */
  async available(to?: string): Promise<OtpChannel[]> {
    const usable = await Promise.all(
      this.allowedChannels.map(async (c) =>
        (await this.isAvailable(c, to)) ? c : null,
      ),
    );
    return usable.filter((c): c is OtpChannel => c !== null);
  }

  async describe(): Promise<OtpChannelDescriptor[]> {
    return (await this.available()).map((channel) => ({
      channel,
      requiresLink: this.requiresLink(channel),
    }));
  }

  /**
   * The channel to use when the caller named none and the user has no saved
   * preference: the first available channel, in `OTP_ALLOWED_CHANNELS` order.
   * With SMS switched off, that is whichever messenger the operator listed
   * first — the flow then continues into linking rather than dead-ending.
   */
  async defaultChannel(to?: string): Promise<OtpChannel | null> {
    return (await this.available(to))[0] ?? null;
  }

  /**
   * Throws the right i18n key if `channel` cannot be used at all — or not for
   * `purpose`. A channel reserved to one purpose (`IOtpSender.onlyFor`) and
   * that purpose go together or not at all: `email` carries only
   * `email_verify`, `email_verify` travels only by `email` (F-035-g). Callers
   * that do not name a purpose are the login and register flows, which may
   * never use a reserved channel.
   */
  async assertUsable(
    channel: OtpChannel,
    purpose?: OtpPurpose,
    to?: string,
  ): Promise<IOtpSender> {
    const sender = this.senders.get(channel);
    if (!sender) throw new BadRequestException(BackendI18nKeys.errors.otp.channelNotSupported);
    const reserved = [...this.senders.values()].some(
      (s) => s.onlyFor !== undefined && s.onlyFor === purpose,
    );
    if (sender.onlyFor !== undefined || reserved) {
      if (sender.onlyFor !== purpose) {
        throw new BadRequestException(BackendI18nKeys.errors.otp.channelNotSupported);
      }
      if (!this.consoleOnly && !(await sender.isConfigured(to))) {
        throw new BadRequestException(BackendI18nKeys.errors.otp.channelNotConfigured);
      }
      return sender;
    }
    if (!this.isAllowed(channel)) {
      throw new BadRequestException(BackendI18nKeys.errors.otp.channelNotAllowed);
    }
    if (!(await this.isAvailable(channel, to))) {
      throw new BadRequestException(BackendI18nKeys.errors.otp.channelNotConfigured);
    }
    return sender;
  }
}
