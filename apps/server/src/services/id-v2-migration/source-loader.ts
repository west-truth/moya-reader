import type { ServerConfig } from '../../config.js';
import { createS3Client, getObjectBuffer } from '../object-storage.js';
import type { BookSourceLoader, SourceBookObject } from './contracts.js';

export class S3BookSourceLoader implements BookSourceLoader {
  constructor(private readonly config: ServerConfig) {}

  async load(object: SourceBookObject): Promise<Buffer> {
    const client = createS3Client(this.config);
    try {
      const stored = await getObjectBuffer(client, this.config, object.storageKey);
      if (stored.body.byteLength !== object.sizeBytes) {
        throw new Error('stored_object_size_mismatch');
      }
      return stored.body;
    } finally {
      client.destroy();
    }
  }
}
