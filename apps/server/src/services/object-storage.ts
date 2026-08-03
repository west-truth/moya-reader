import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { ServerConfig } from '../config.js';

export function createS3Client(config: ServerConfig): S3Client {
  return new S3Client({
    endpoint: config.s3.endpoint,
    region: config.s3.region,
    forcePathStyle: config.s3.forcePathStyle,
    credentials: {
      accessKeyId: config.s3.accessKeyId,
      secretAccessKey: config.s3.secretAccessKey,
    },
  });
}

export async function ensureBucket(client: S3Client, bucket: string): Promise<void> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}

export async function putRawBookObject(
  client: S3Client,
  config: ServerConfig,
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  await ensureBucket(client, config.s3.bucket);
  await client.send(
    new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

export async function putTtsAudioObject(
  client: S3Client,
  config: ServerConfig,
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  await ensureBucket(client, config.s3.bucket);
  await client.send(
    new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

export interface StoredObject {
  readonly body: Buffer;
  readonly contentType?: string;
  readonly contentLength?: number;
}

export interface StoredObjectStream {
  readonly body: Readable;
  readonly contentType?: string;
  readonly contentLength?: number;
}

export async function getObjectStream(
  client: S3Client,
  config: ServerConfig,
  key: string,
  range?: { readonly startInclusive: number; readonly endInclusive: number },
): Promise<StoredObjectStream> {
  const result = await client.send(
    new GetObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
      ...(range ? { Range: `bytes=${range.startInclusive}-${range.endInclusive}` } : {}),
    }),
  );
  return {
    body: objectBodyToReadable(result.Body),
    contentType: result.ContentType,
    contentLength: result.ContentLength,
  };
}

export async function getObjectBuffer(client: S3Client, config: ServerConfig, key: string): Promise<StoredObject> {
  const result = await client.send(
    new GetObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
    }),
  );
  return {
    body: await objectBodyToBuffer(result.Body),
    contentType: result.ContentType,
    contentLength: result.ContentLength,
  };
}

export async function getObjectRangeBuffer(
  client: S3Client,
  config: ServerConfig,
  key: string,
  startInclusive: number,
  endInclusive: number,
): Promise<StoredObject> {
  const result = await client.send(
    new GetObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
      Range: `bytes=${startInclusive}-${endInclusive}`,
    }),
  );
  return {
    body: await objectBodyToBuffer(result.Body),
    contentType: result.ContentType,
    contentLength: result.ContentLength,
  };
}

export async function deleteObject(client: S3Client, config: ServerConfig, key: string): Promise<void> {
  await client.send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: key }));
}

async function objectBodyToBuffer(body: unknown): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof (body as { arrayBuffer?: unknown }).arrayBuffer === 'function') {
    const arrayBuffer = await (body as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
  if (typeof (body as { transformToByteArray?: unknown }).transformToByteArray === 'function') {
    const bytes = await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
    return Buffer.from(bytes);
  }
  const stream = body as Readable;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function objectBodyToReadable(body: unknown): Readable {
  if (body instanceof Readable) return body;
  if (body instanceof Uint8Array) return Readable.from([body]);
  throw new TypeError('Stored object body is not a readable stream.');
}
