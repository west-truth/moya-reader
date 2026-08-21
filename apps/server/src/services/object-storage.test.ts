import { CreateBucketCommand, HeadBucketCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '../config.js';
import { putRawBookObject } from './object-storage.js';

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
});
