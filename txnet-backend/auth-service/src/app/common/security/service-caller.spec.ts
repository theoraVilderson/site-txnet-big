import { ConfigService } from '@nestjs/config';
import { RequestHeaders } from '@txnet-backend/shared-core';

import {
  isServiceCaller,
  rateLimitSubject,
  ServiceCallerMiddleware,
} from './service-caller';

const TOKEN = 'a'.repeat(40);

function run(
  headers: Record<string, string>,
  configured: string | undefined = TOKEN,
) {
  const config = {
    get: jest.fn().mockReturnValue(configured),
  } as unknown as ConfigService;
  const middleware = new ServiceCallerMiddleware(config);
  const req: any = { headers, ip: '203.0.113.9' };
  const next = jest.fn();
  middleware.use(req, {} as any, next);
  expect(next).toHaveBeenCalled();
  return req;
}

describe('ServiceCallerMiddleware', () => {
  it('marks a call carrying the configured token', () => {
    const req = run({ 'x-service-token': TOKEN, 'x-bot-chat-id': '5501' });

    expect(isServiceCaller(req)).toBe(true);
    // One bot is many users behind one IP: the limit counts the chat, not the
    // socket, or the tenth user of the hour locks out everyone else (ADR-0011).
    expect(rateLimitSubject(req)).toBe('bot:5501');
  });

  it('treats a wrong token as an ordinary browser call', () => {
    const req = run({ 'x-service-token': 'b'.repeat(40), 'x-bot-chat-id': '5501' });

    expect(isServiceCaller(req)).toBe(false);
    expect(rateLimitSubject(req)).toBe('203.0.113.9');
  });

  it('refuses every service call when no token is configured', () => {
    // The empty-string case matters: an unset env var must never mean "open".
    const req = run({ 'x-service-token': '' }, undefined);

    expect(isServiceCaller(req)).toBe(false);
  });

  it('falls back to the IP when a service call names no chat', () => {
    const req = run({ 'x-service-token': TOKEN });

    expect(isServiceCaller(req)).toBe(true);
    expect(rateLimitSubject(req)).toBe('203.0.113.9');
  });

  /**
   * F-074. This service and `bot-service` each declared their own
   * `SERVICE_TOKEN_HEADER` holding the same string, and the chat and platform
   * headers were re-spelled raw at six more call sites. Both now come from
   * `contracts/http/wire.json` through `shared-core` (ADR-0036, C-04).
   *
   * The spec above deliberately keeps its literals — it is asserting the
   * strings that actually go on the wire, which is the one place a literal is
   * the point rather than a duplicate. This test is what joins the two: the
   * middleware reads the *declared* name, so a rename in the fixture makes
   * these tests fail rather than quietly reading a header nobody sends.
   */
  it('reads the header names the wire contract declares', () => {
    const req = run({
      [RequestHeaders.serviceToken]: TOKEN,
      [RequestHeaders.botChatId]: '5501',
    });

    expect(isServiceCaller(req)).toBe(true);
    expect(rateLimitSubject(req)).toBe('bot:5501');
  });

  it('answers for a request the middleware never saw', () => {
    expect(isServiceCaller(undefined)).toBe(false);
    expect(rateLimitSubject({ ip: '198.51.100.4' })).toBe('198.51.100.4');
  });
});
