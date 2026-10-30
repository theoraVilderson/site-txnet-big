import { createHash } from 'node:crypto';

import { DeleteObjectCommand, GetObjectCommand, NoSuchKey, PutObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';

import { objectDriverFromEnv } from './object-storage';
import { S3ObjectDriver, type S3Sender } from './s3-driver';

const KEY = 'tenants/11111111-1111-4111-8111-111111111111/support/a.png';
const BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

type Sent = PutObjectCommand | GetObjectCommand | DeleteObjectCommand;

/** A bucket held in a map, answering the three commands the driver sends. */
function fakeBucket(): S3Sender & { objects: Map<string, Buffer>; sent: Sent[] } {
  const objects = new Map<string, Buffer>();
  const sent: Sent[] = [];
  return {
    objects,
    sent,
    async send(command: Sent) {
      sent.push(command);
      const key = command.input.Key ?? '';
      if (command instanceof PutObjectCommand) {
        objects.set(key, Buffer.from(command.input.Body as Buffer));
        return { $metadata: {} };
      }
      if (command instanceof GetObjectCommand) {
        const body = objects.get(key);
        if (!body) throw new NoSuchKey({ message: 'The specified key does not exist.', $metadata: {} });
        return { $metadata: {}, Body: { transformToByteArray: async () => new Uint8Array(body) } };
      }
      objects.delete(key);
      return { $metadata: {} };
    },
  };
}

describe('the s3 object driver (F-018-m2-a)', () => {
  it('writes the bytes at the key, in the bucket, with their MD5 so a damaged upload is refused', async () => {
    const bucket = fakeBucket();
    await new S3ObjectDriver(bucket, 'txnet-main-data').write(KEY, BYTES);
    const put = bucket.sent[0] as PutObjectCommand;
    expect(put.input).toMatchObject({ Bucket: 'txnet-main-data', Key: KEY });
    expect(put.input.ContentMD5).toBe(createHash('md5').update(BYTES).digest('base64'));
    expect(bucket.objects.get(KEY)).toEqual(BYTES);
  });

  it('reads back the same bytes, and null for a key that holds none', async () => {
    const driver = new S3ObjectDriver(fakeBucket(), 'b');
    await driver.write(KEY, BYTES);
    expect(await driver.read(KEY)).toEqual(BYTES);
    expect(await driver.read(KEY.replace('a.png', 'missing.png'))).toBeNull();
  });

  it('lets any other failure through: an unreachable bucket is not an absent file', async () => {
    const down: S3Sender = { send: async () => Promise.reject(new Error('connect ETIMEDOUT')) };
    await expect(new S3ObjectDriver(down, 'b').read(KEY)).rejects.toThrow('ETIMEDOUT');
  });

  it('removes the key, and removing it twice is fine', async () => {
    const bucket = fakeBucket();
    const driver = new S3ObjectDriver(bucket, 'b');
    await driver.write(KEY, BYTES);
    await driver.remove(KEY);
    await driver.remove(KEY);
    expect(bucket.objects.size).toBe(0);
  });

  it('refuses a string that is not an object key before anything is sent', async () => {
    const bucket = fakeBucket();
    await expect(new S3ObjectDriver(bucket, 'b').write('../etc/passwd', BYTES)).rejects.toThrow('not an object key');
    expect(bucket.sent).toHaveLength(0);
  });
});

describe('choosing the s3 driver from the environment', () => {
  const S3_ENV = {
    OBJECT_STORAGE_DRIVER: 's3',
    OBJECT_STORAGE_S3_ENDPOINT: 'https://hot.ir-central1.arvanstorage.ir',
    OBJECT_STORAGE_S3_REGION: 'ir-central1',
    OBJECT_STORAGE_S3_BUCKET: 'txnet-main-data',
    OBJECT_STORAGE_S3_ACCESS_KEY_ID: 'k',
    OBJECT_STORAGE_S3_SECRET_ACCESS_KEY: 's',
  };

  it('builds it when every setting is there', () => {
    expect(objectDriverFromEnv(S3_ENV)).toBeInstanceOf(S3ObjectDriver);
  });

  it('names the missing setting at boot instead of failing on the first upload', () => {
    expect(() => objectDriverFromEnv({ ...S3_ENV, OBJECT_STORAGE_S3_BUCKET: '' })).toThrow('OBJECT_STORAGE_S3_BUCKET');
  });
});
