import {
  CreateBucketCommand,
  CopyObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import * as fs from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '../config.js';
import { copyStoredObject, inspectStoredObject, putRawBookObject, putTtsAudioObject } from './object-storage.js';

vi.mock('node:fs/promises', async (original) => ({ ...(await original<typeof fs>()), statfs: vi.fn() }));
afterEach(() => vi.resetAllMocks());

function config(): ServerConfig {
  return {
    s3: {
      bucket: 'moya-test',
    },
  } as ServerConfig;
}

describe('object storage writes', () => {
  it('rejects insufficient space before upload or copy without sending a write', async () => {
    vi.mocked(fs.statfs).mockResolvedValue({ bsize: 1n, blocks: 1000n, bavail: 100n } as never);
    const options = { ...config(), storageCapacityPath: '/fixture', storageMinimumFreeBytes: 90 };
    const send = vi.fn(async (_command: unknown) => ({ ContentLength: 20 }));
    const client = { send } as unknown as S3Client;
    await expect(
      putRawBookObject(client, options, 'raw', new Blob(['12345678901']), 'text/plain'),
    ).rejects.toMatchObject({ statusCode: 507 });
    await expect(putTtsAudioObject(client, options, 'tts', Buffer.alloc(20), 'audio/wav')).rejects.toMatchObject({
      statusCode: 507,
    });
    expect(send).not.toHaveBeenCalled();
    await expect(copyStoredObject(client, options, 'source', 'copy')).rejects.toMatchObject({ statusCode: 507 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBeInstanceOf(HeadObjectCommand);
    vi.mocked(fs.statfs).mockResolvedValue({ bsize: 1n, blocks: 1000n, bavail: 1000n } as never);
    await copyStoredObject(client, options, 'source', 'copy');
    expect(send.mock.calls.at(-1)![0]).toBeInstanceOf(CopyObjectCommand);
  });

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
