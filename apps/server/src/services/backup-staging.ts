import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, openAsBlob } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { assertUploadDiskSpace, UploadSpaceError } from './upload-file.js';
import {
  MAX_HOSTED_BACKUP_ARCHIVE_BYTES,
  parseHostedBackupArchive,
  type ParsedHostedBackupArchive,
} from './hosted-backup-archive.js';
import { convertLocalBackup } from './local-backup-converter.js';

const INSPECTION_TTL = 30 * 60_000;
interface StagedBackup {
  parsed: ParsedHostedBackupArchive;
  source: 'hosted' | 'local';
  byteLength: number;
  expires: number;
  dispose(): Promise<void>;
}

/** Only deletes directories created by this instance; never scans/deletes another request's files. */
export class BackupStaging {
  private readonly ready = new Map<string, StagedBackup>();
  private occupied = 0;
  private readonly timer: NodeJS.Timeout;
  constructor(
    private readonly root: string,
    private readonly userId?: string,
  ) {
    this.timer = setInterval(() => void this.expire().catch(() => undefined), 60_000);
    this.timer.unref();
  }

  private async expire() {
    for (const [id, stage] of this.ready) {
      if (stage.expires <= Date.now()) {
        this.ready.delete(id);
        await stage.dispose();
      }
    }
  }

  async receive(
    input: Readable,
    expectedBytes?: number,
    signal?: AbortSignal,
    onBytesReceived?: (bytes: number) => void,
  ): Promise<{ id: string; stage: StagedBackup }> {
    await this.expire();
    if (this.occupied >= 2) throw new Error('다른 백업 작업이 진행 중입니다. 잠시 후 다시 시도해 주세요.');
    if (
      expectedBytes !== undefined &&
      (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > MAX_HOSTED_BACKUP_ARCHIVE_BYTES)
    )
      throw new Error('백업 ZIP은 257GiB까지 지원합니다.');
    this.occupied++;
    let directory: string | undefined;
    let disposed = false;
    const dispose = async () => {
      if (disposed) return;
      disposed = true;
      try {
        if (directory) await rm(directory, { recursive: true, force: true });
      } finally {
        this.occupied--;
      }
    };
    try {
      await assertUploadDiskSpace(this.root, expectedBytes ?? 0);
      directory = await mkdtemp(path.join(this.root, 'backup-'));
      const zipPath = path.join(directory, 'archive.zip');
      let byteLength = 0;
      const archiveHash = createHash('sha256');
      async function* chunks() {
        for await (const chunk of input) {
          byteLength += chunk.length;
          if (
            byteLength > MAX_HOSTED_BACKUP_ARCHIVE_BYTES ||
            (expectedBytes !== undefined && byteLength > expectedBytes)
          )
            throw new Error('백업 ZIP 용량 제한을 초과했습니다.');
          archiveHash.update(chunk);
          yield chunk;
          onBytesReceived?.(byteLength);
        }
        if (expectedBytes !== undefined && byteLength !== expectedBytes)
          throw new Error('백업 업로드가 완료되지 않았습니다.');
      }
      await pipeline(chunks(), createWriteStream(zipPath, { flags: 'wx', mode: 0o600 }), { signal });
      const assets = path.join(directory, 'assets');
      await mkdir(assets);
      const archiveBlob = await openAsBlob(zipPath);
      const digest = `sha256:${archiveHash.digest('hex')}`;
      let parsed: ParsedHostedBackupArchive;
      let source: StagedBackup['source'] = 'hosted';
      try {
        parsed = await parseHostedBackupArchive(archiveBlob, { assetDirectory: assets, signal, archiveHash: digest });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'Unsupported hosted backup manifest' || !this.userId) {
          throw error;
        }
        parsed = await convertLocalBackup(archiveBlob, this.userId, digest, signal);
        source = 'local';
      }
      signal?.throwIfAborted();
      await rm(zipPath);
      const id = randomBytes(32).toString('base64url');
      const stage = { parsed, source, byteLength, expires: Date.now() + INSPECTION_TTL, dispose };
      this.ready.set(id, stage);
      return { id, stage };
    } catch (error) {
      await dispose();
      if ((error as NodeJS.ErrnoException).code === 'ENOSPC') throw new UploadSpaceError();
      throw error;
    }
  }

  take(id: string): StagedBackup {
    const stage = this.ready.get(id);
    if (!stage) throw new Error('백업 검사 결과가 만료되었습니다. 파일을 다시 선택해 주세요.');
    this.ready.delete(id); // Claim before any await: expiry/discard cannot remove an executing restore.
    if (stage.expires <= Date.now()) {
      void stage.dispose().catch(() => undefined);
      throw new Error('백업 검사 결과가 만료되었습니다. 파일을 다시 선택해 주세요.');
    }
    return stage;
  }

  async discard(id: string) {
    const stage = this.ready.get(id);
    this.ready.delete(id);
    await stage?.dispose();
  }

  async close() {
    clearInterval(this.timer);
    for (const id of this.ready.keys()) await this.discard(id);
  }
}
