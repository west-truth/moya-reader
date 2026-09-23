import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { addAbortSignal, Readable } from 'node:stream';

function storageError(code: string, status: number): Error {
  return Object.assign(new Error(code), { name: code, $metadata: { httpStatusCode: status } });
}

/** Server object backend: metadata and bytes are published together by one rename. */
export class FileObjectStore {
  constructor(readonly directory: string) {}

  destroy(): void {
    /* No persistent connections. */
  }

  async ensureBucket(_bucket: string): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
  }

  private filename(bucket: string, key: string): string {
    if (!bucket || !key) throw new Error('Object bucket and key are required');
    // Keys are opaque, including slashes, Unicode and Windows reserved names.
    const digest = createHash('sha256')
      .update(JSON.stringify([bucket, key]))
      .digest('hex');
    return path.join(this.directory, digest.slice(0, 2), `${digest}.object`);
  }

  async put(
    bucket: string,
    key: string,
    body: Buffer | Blob,
    contentType: string,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const target = this.filename(bucket, key);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try {
      const metadata = Buffer.from(JSON.stringify({ version: 1, contentType }));
      if (metadata.length > 64 * 1024) throw new Error('Object metadata is too large');
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32BE(metadata.length);
      await file.writeFile(Buffer.concat([prefix, metadata]));
      const stream = body instanceof Blob ? Readable.fromWeb(body.stream() as never) : Readable.from([body]);
      if (signal) addAbortSignal(signal, stream);
      for await (const chunk of stream) {
        signal?.throwIfAborted();
        await file.writeFile(chunk);
      }
      await file.sync();
      await file.close();
      signal?.throwIfAborted();
      await rename(temporary, target);
    } finally {
      await file.close();
      await rm(temporary, { force: true });
    }
  }

  async get(
    bucket: string,
    key: string,
    range?: { startInclusive: number; endInclusive: number },
    signal?: AbortSignal,
  ): Promise<{ body: Readable; contentType: string; contentLength: number }> {
    signal?.throwIfAborted();
    const file = await open(this.filename(bucket, key), 'r').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') throw storageError('NoSuchKey', 404);
      throw error;
    });
    try {
      const prefix = Buffer.alloc(4);
      if ((await file.read(prefix, 0, 4, 0)).bytesRead !== 4) throw new Error('Invalid object header');
      const length = prefix.readUInt32BE();
      if (length > 64 * 1024) throw new Error('Invalid object header');
      const metadata = Buffer.alloc(length);
      if ((await file.read(metadata, 0, length, 4)).bytesRead !== length) throw new Error('Invalid object header');
      const header: { version: number; contentType: string } = JSON.parse(metadata.toString('utf8'));
      if (header.version !== 1 || typeof header.contentType !== 'string') throw new Error('Invalid object header');
      const offset = 4 + length;
      const size = (await file.stat()).size - offset;
      if (size < 0) throw new Error('Invalid object length');
      if (
        range &&
        (!Number.isSafeInteger(range.startInclusive) ||
          !Number.isSafeInteger(range.endInclusive) ||
          range.startInclusive < 0 ||
          range.endInclusive < range.startInclusive ||
          range.startInclusive >= size)
      ) {
        throw storageError('InvalidRange', 416);
      }
      const start = range?.startInclusive ?? 0;
      const end = Math.min(range?.endInclusive ?? size - 1, size - 1);
      if (size === 0) {
        await file.close();
        return { body: Readable.from([]), contentType: header.contentType, contentLength: 0 };
      }
      const body = file.createReadStream({ start: offset + start, end: offset + end, autoClose: true, signal });
      return { body, contentType: header.contentType, contentLength: end - start + 1 };
    } catch (error) {
      await file.close();
      throw error;
    }
  }

  async inspect(bucket: string, key: string): Promise<{ byteLength: number; contentType: string } | undefined> {
    try {
      const object = await this.get(bucket, key);
      object.body.destroy();
      return { byteLength: object.contentLength, contentType: object.contentType };
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return undefined;
      throw error;
    }
  }

  async delete(bucket: string, key: string): Promise<void> {
    await rm(this.filename(bucket, key), { force: true });
  }

  async copy(bucket: string, sourceKey: string, targetKey: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const source = await open(this.filename(bucket, sourceKey), 'r');
    const target = this.filename(bucket, targetKey);
    const temporary = `${target}.${randomUUID()}.tmp`;
    let destination;
    try {
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      destination = await open(temporary, 'wx', 0o600);
      const stream = source.createReadStream({ signal });
      for await (const chunk of stream) {
        signal?.throwIfAborted();
        await destination.writeFile(chunk);
      }
      await destination.sync();
      await destination.close();
      signal?.throwIfAborted();
      await rename(temporary, target);
    } finally {
      await source.close();
      await destination?.close();
      await rm(temporary, { force: true });
    }
  }
}
