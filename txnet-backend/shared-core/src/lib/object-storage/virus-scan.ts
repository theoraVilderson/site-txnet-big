import { connect } from 'node:net';

/**
 * The virus-scan hook (F-033-c, ADR-0113): bytes a user uploads go past a
 * scanner before anyone else can fetch them.
 *
 * `clamd` speaks ClamAV's INSTREAM protocol over TCP. `none` scans nothing and
 * calls every file clean — a dev stack without a ClamAV container; the service
 * says so in its log at boot. A scanner that cannot answer is `failed`, never
 * `clean`: a file nobody looked at is not served.
 */

export type ScanVerdict =
  | { status: 'clean' }
  | { status: 'infected'; signature: string }
  | { status: 'failed'; reason: string };

export interface VirusScanner {
  readonly name: 'clamd' | 'none';
  scan(bytes: Buffer): Promise<ScanVerdict>;
}

/** clamd's default `StreamMaxLength` is 25 MB; chunks well under it. */
const CHUNK = 64 * 1024;

export class ClamdScanner implements VirusScanner {
  readonly name = 'clamd' as const;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly timeoutMs: number,
  ) {}

  scan(bytes: Buffer): Promise<ScanVerdict> {
    return new Promise((resolve) => {
      let reply = '';
      let settled = false;
      const done = (v: ScanVerdict) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(v);
      };
      const socket = connect({ host: this.host, port: this.port });
      socket.setTimeout(this.timeoutMs, () => done({ status: 'failed', reason: 'timeout' }));
      socket.on('error', (e) => done({ status: 'failed', reason: e.message }));
      socket.on('connect', () => {
        // `z` prefix: commands and replies end in NUL.
        socket.write('zINSTREAM\0');
        for (let i = 0; i < bytes.length; i += CHUNK) {
          const part = bytes.subarray(i, i + CHUNK);
          const size = Buffer.alloc(4);
          size.writeUInt32BE(part.length, 0);
          socket.write(size);
          socket.write(part);
        }
        socket.write(Buffer.alloc(4));
      });
      socket.on('data', (chunk) => {
        reply += chunk.toString('utf8');
      });
      socket.on('end', () => done(verdictOf(reply)));
      socket.on('close', () => done(verdictOf(reply)));
    });
  }
}

/** `stream: OK`, `stream: <name> FOUND`, or anything else (`… ERROR`). */
function verdictOf(raw: string): ScanVerdict {
  const reply = raw.replace(/\0+$/, '').trim();
  if (reply === 'stream: OK') return { status: 'clean' };
  const found = /^stream: (.+) FOUND$/.exec(reply);
  if (found) return { status: 'infected', signature: found[1] };
  return { status: 'failed', reason: reply || 'no reply' };
}

export class NoScanner implements VirusScanner {
  readonly name = 'none' as const;

  async scan(): Promise<ScanVerdict> {
    return { status: 'clean' };
  }
}

export interface VirusScanEnv {
  VIRUS_SCAN_DRIVER?: string;
  /** `host:port` of clamd. */
  CLAMD_ADDR?: string;
  CLAMD_TIMEOUT_MS?: number;
}

export function scannerFromEnv(env: VirusScanEnv): VirusScanner {
  const driver = env.VIRUS_SCAN_DRIVER || 'none';
  if (driver === 'none') return new NoScanner();
  if (driver !== 'clamd') throw new Error(`VIRUS_SCAN_DRIVER=${driver} is not built; "clamd" or "none"`);
  const match = /^([^:\s]+):(\d{1,5})$/.exec(env.CLAMD_ADDR ?? '');
  if (!match) throw new Error('CLAMD_ADDR must be host:port when VIRUS_SCAN_DRIVER=clamd');
  return new ClamdScanner(match[1], Number(match[2]), env.CLAMD_TIMEOUT_MS ?? 10_000);
}
