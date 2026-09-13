import { createHash, randomUUID } from 'node:crypto';
import type { HostedImageDownload } from '../../../../src/services/import/hosted-image-import.js';

interface Entry {
  generation: string;
  sourceId: string;
  remoteId: string;
  file: File;
  hash: string;
  expiresAt: number;
  busy: boolean;
}

/** Request staging only. Restart drops unfinished downloads; durable import jobs use upload_sessions. */
export class PreparedImageDownloads {
  private entries = new Map<string, Entry>();
  private timer: ReturnType<typeof setInterval>;
  constructor(
    private readonly maxBytes = 512 * 1024 * 1024,
    private readonly ttlMs = 15 * 60_000,
  ) {
    this.timer = setInterval(() => this.prune(), Math.min(ttlMs, 60_000));
    this.timer.unref();
  }
  private prune() {
    for (const [id, entry] of this.entries) {
      if (!entry.busy && entry.expiresAt <= Date.now()) this.entries.delete(id);
    }
  }
  async put(
    sourceId: string,
    remoteId: string,
    file: File,
    signal: AbortSignal,
    generation = '',
  ): Promise<HostedImageDownload> {
    this.prune();
    if (
      this.entries.size >= 8 ||
      [...this.entries.values()].reduce((sum, entry) => sum + entry.file.size, file.size) > this.maxBytes
    )
      throw new Error('source_storage_limit');
    const id = randomUUID();
    // Reserve capacity before awaiting the hash, including concurrent downloads.
    const entry: Entry = {
      generation,
      sourceId,
      remoteId,
      file,
      hash: '',
      expiresAt: Date.now() + this.ttlMs,
      busy: true,
    };
    this.entries.set(id, entry);
    try {
      const hash = createHash('sha256');
      for (let offset = 0; offset < file.size; offset += 2 * 1024 * 1024) {
        signal.throwIfAborted();
        hash.update(Buffer.from(await file.slice(offset, offset + 2 * 1024 * 1024).arrayBuffer()));
      }
      signal.throwIfAborted();
      entry.hash = `sha256:${hash.digest('hex')}`;
      entry.busy = false;
      return { artifactId: id, sourceContentHash: entry.hash, byteLength: file.size };
    } catch (error) {
      this.entries.delete(id);
      throw error;
    }
  }
  async consume<T>(
    id: string,
    sourceId: string,
    remoteId: string,
    run: (file: File, hash: string) => Promise<T>,
    generation = '',
    retain = false,
  ): Promise<T> {
    this.prune();
    const entry = this.entries.get(id);
    if (
      !entry ||
      entry.sourceId !== sourceId ||
      entry.remoteId !== remoteId ||
      entry.generation !== generation ||
      entry.busy
    )
      throw new Error('prepared_download_unavailable');
    entry.busy = true;
    try {
      return await run(entry.file, entry.hash);
    } finally {
      if (retain) entry.busy = false;
      else this.entries.delete(id);
    }
  }
  discard(id: string, sourceId: string) {
    const entry = this.entries.get(id);
    if (entry?.sourceId === sourceId && !entry.busy) this.entries.delete(id);
  }
  close() {
    clearInterval(this.timer);
    this.entries.clear();
  }
}
