import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpAdapterHost } from '@nestjs/core';
import { headerValue } from '@txnet-backend/shared-core';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { Duplex } from 'node:stream';

import { PROBE_NONCE, PROBE_PATH } from './domain-check';
import { TenantDomainService } from './tenant-domain.service';
import { acceptOf, CLOSE_FRAME, textFrame } from './ws-frame';

/** Answers whether a host has a domain row, as the http probe does. */
type KnownHost = (host: string | undefined, nonce: string) => Promise<unknown>;

const NOT_FOUND = Buffer.from('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n', 'latin1');

/**
 * The bytes an upgrade on `url` gets (NIN-1-e2): on the probe path, with a
 * nonce the check made, a key, and a host with a `tenant_domain` row, a 101
 * and the nonce as the one message; anything else the neutral 404 (F-1210).
 */
export async function answerUpgrade(url: string, headers: IncomingHttpHeaders, path: string, known: KnownHost): Promise<Buffer> {
  const parsed = new URL(url, 'http://probe');
  const nonce = parsed.searchParams.get('n') ?? '';
  const key = headerValue(headers, 'sec-websocket-key');
  if (parsed.pathname !== path || !PROBE_NONCE.test(nonce) || !key) return NOT_FOUND;
  if (!(await known(headerValue(headers, 'host'), nonce))) return NOT_FOUND;
  const head = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${acceptOf(key)}`, '', ''].join('\r\n');
  return Buffer.concat([Buffer.from(head, 'latin1'), textFrame(nonce), CLOSE_FRAME]);
}

/**
 * The domain check's WebSocket line, served (NIN-1-e2): a reseller's own edge
 * must carry an upgrade and a frame back, or the panel's live updates never
 * arrive through it. tenant-service has no other WebSocket, so it takes every
 * upgrade on its server and refuses all but the probe's.
 */
@Injectable()
export class DomainProbeSocket implements OnApplicationBootstrap {
  private readonly logger = new Logger(DomainProbeSocket.name);
  private readonly path: string;

  constructor(
    private readonly adapter: HttpAdapterHost,
    private readonly domains: TenantDomainService,
    config: ConfigService,
  ) {
    this.path = `/${config.get<string>('GLOBAL_PREFIX') ?? 'api'}/${PROBE_PATH}`;
  }

  onApplicationBootstrap(): void {
    const server = this.adapter.httpAdapter.getHttpServer() as Server;
    server.on('upgrade', (req, socket: Duplex) => {
      answerUpgrade(req.url ?? '/', req.headers, this.path, (host, nonce) => this.domains.probeAnswer(host, nonce))
        .then((out) => socket.end(out))
        .catch((e: unknown) => {
          this.logger.warn(`domain probe upgrade failed: ${(e as Error).message}`);
          socket.end(NOT_FOUND);
        });
    });
  }
}
