import { createHash } from 'node:crypto';

import { DeleteObjectCommand, GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

import { parseObjectKey } from './object-key';
import type { ObjectDriver } from './object-storage';

/** The three commands the driver sends. */
type DriverCommand = PutObjectCommand | GetObjectCommand | DeleteObjectCommand;

/** What the driver reads of a reply: every reply's `$metadata`, and a GET's body. */
export interface S3Reply {
  $metadata: object;
  Body?: { transformToByteArray(): Promise<Uint8Array> };
}

/** What the driver needs of a client: S3Client in a service, a map in a spec. */
export interface S3Sender {
  send(command: DriverCommand): Promise<S3Reply>;
}

/** The settings of {@link s3Sender}, from `OBJECT_STORAGE_S3_*` (contract "Configuration"). */
export interface S3Settings {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** `bucket` in the path, not the host name: what MinIO and most non-AWS stores expect. */
  forcePathStyle: boolean;
}

// C-28: every outside call has a timeout. A 50 MiB guide video is the largest
// object (F-414-i); two minutes is ample for it on a domestic link.
const CONNECT_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 3;

/** An S3Client for any S3-compatible store (Arvan, MinIO, AWS). */
export function s3Sender(settings: S3Settings): S3Sender {
  const client = new S3Client({
    endpoint: settings.endpoint,
    region: settings.region,
    credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
    forcePathStyle: settings.forcePathStyle,
    maxAttempts: MAX_ATTEMPTS,
    requestHandler: { connectionTimeout: CONNECT_TIMEOUT_MS, requestTimeout: REQUEST_TIMEOUT_MS },
    // The SDK's default CRC checksums are AWS's; S3-compatible stores refuse or
    // ignore them. The driver sends Content-MD5, which every store checks.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return {
    send(command) {
      // One call per command type: S3Client.send is typed by the command it is given.
      if (command instanceof PutObjectCommand) return client.send(command);
      if (command instanceof GetObjectCommand) return client.send(command);
      return client.send(command);
    },
  };
}

/**
 * A bucket; the key is the object's name in it (rule 1: the same string as on
 * the local volume, so a move is a copy by key). Any node reaches it, so its
 * users need no pin to the data node (rule 5, hosting K17).
 */
export class S3ObjectDriver implements ObjectDriver {
  constructor(
    private readonly s3: S3Sender,
    private readonly bucket: string,
  ) {}

  async write(key: string, bytes: Buffer): Promise<void> {
    // The store refuses a body whose MD5 differs: a damaged upload fails here
    // instead of leaving a row whose sha256 the bytes do not match (rule 3).
    const ContentMD5 = createHash('md5').update(bytes).digest('base64');
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.checked(key), Body: bytes, ContentMD5 }));
  }

  async read(key: string): Promise<Buffer | null> {
    try {
      const { Body } = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.checked(key) }));
      return Body ? Buffer.from(await Body.transformToByteArray()) : null;
    } catch (e) {
      // Only an absent key is an absent file; a store that does not answer is an error.
      if (e instanceof NoSuchKey) return null;
      throw e;
    }
  }

  async remove(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.checked(key) }));
  }

  /** The same guard as the local driver's: nothing but a parsed key reaches the store. */
  private checked(key: string): string {
    if (!parseObjectKey(key)) throw new Error(`not an object key: ${JSON.stringify(key)}`);
    return key;
  }
}
