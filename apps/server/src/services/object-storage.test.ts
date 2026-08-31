import {
  CreateBucketCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '../config.js';
import { inspectStoredObject, putRawBookObject } from './object-storage.js';

function config(): ServerConfig {
  return {
    s3: {
      bucket: 'moya-test',
    },
  } as ServerConfig;
}

describe('object storage writes', () => {
  it('checks bucket readiness only once for repeated writes on the same client', async () => {
    const commands: unknown[] = [];
    const client = {
      send: vi.fn(async (command: unknown) => {
        commands.push(command);
        return {};
      }),
    } as unknown as S3Client;

    await putRawBookObject(client, config(), 'books/source.epub', Buffer.from('source'), 'application/epub+zip');
    await putRawBookObject(client, config(), 'books/image.png', Buffer.from('image'), 'image/png');

    expect(commands.filter((command) => command instanceof HeadBucketCommand)).toHaveLength(1);
    expect(commands.filter((command) => command instanceof CreateBucketCommand)).toHaveLength(0);
    expect(commands.filter((command) => command instanceof PutObjectCommand)).toHaveLength(2);
  });

  it('inspects existing object metadata without downloading its body', async () => {
    const send = vi.fn(async (_command: unknown) => ({ ContentLength: 42, ContentType: 'image/png' }));
    expect(await inspectStoredObject({ send } as unknown as S3Client, config(), 'page')).toEqual({
      byteLength: 42,
      contentType: 'image/png',
    });
    expect(send.mock.calls[0]![0]).toBeInstanceOf(HeadObjectCommand);
    expect((send.mock.calls[0]![0] as HeadObjectCommand).input).toEqual({ Bucket: 'moya-test', Key: 'page' });
  });

  it.each([403, 404, 503])('only treats an object HEAD 404 as a missing object (%i)', async (status) => {
    const error = Object.assign(new Error('Object HEAD failed'), { $metadata: { httpStatusCode: status } });
    const client = {
      send: vi.fn(async () => {
        throw error;
      }),
    } as unknown as S3Client;
    const result = inspectStoredObject(client, config(), 'page');
    if (status === 404) expect(await result).toBeUndefined();
    else await expect(result).rejects.toBe(error);
  });
});
