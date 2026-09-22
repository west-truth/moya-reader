import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BackupStaging } from './backup-staging.js';
import { createHostedBackupStream, type HostedBackupSnapshot } from './hosted-backup-archive.js';
import { hashBackupBlob } from './backup-streams.js';

const hash = (value: Uint8Array) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
function snapshot(bytes = 3, digest = hash(Buffer.from('abc'))): HostedBackupSnapshot {
  return {
    tables: new Map([
      ['library_books', []],
      ['reader_settings', []],
    ]),
    books: [],
    exportedAt: '2026-09-22T00:00:00Z',
    appVersion: 'test',
    objects: [
      {
        id: 'source',
        raw_text_hash: digest,
        size_bytes: bytes,
        storage_key: 'source',
        file_name: 'source.cbz',
        content_type: 'application/zip',
        created_at: '2026-09-22T00:00:00Z',
      },
    ],
  };
}

async function withStaging(run: (stage: BackupStaging, directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'moya-backup-test-'));
  const staging = new BackupStaging(directory);
  try {
    await run(staging, directory);
  } finally {
    await staging.close();
    await rm(directory, { recursive: true, force: true });
  }
}
async function receive(staging: BackupStaging) {
  const zip = createHostedBackupStream(snapshot(), async () => Buffer.from('abc'));
  const [result] = await Promise.all([staging.receive(Readable.fromWeb(zip.readable as never)), zip.completion]);
  return result;
}

describe('disk staged backup', () => {
  it('roundtrips 513MiB and more than 1,000 entries without a whole-archive/object buffer', async () => {
    await withStaging(async (staging, directory) => {
      const block = Buffer.alloc(64 * 1024, 123);
      const size = (Number(process.env.MOYA_BACKUP_STREAM_TEST_MIB) || 513) * 1024 ** 2;
      const expected = createHash('sha256');
      for (let count = 0; count < size; count += block.length) expected.update(block);
      const digest = `sha256:${expected.digest('hex')}`;
      const base = snapshot(size, digest);
      const tiny = snapshot().objects[0];
      const zip = createHostedBackupStream(
        {
          ...base,
          objects: [...base.objects, ...Array.from({ length: 1001 }, (_, i) => ({ ...tiny, id: `tiny-${i}` }))],
        },
        async (object) => {
          if (object.id !== 'source') return Buffer.from('abc');
          let remaining = size;
          return new ReadableStream<Uint8Array>({
            pull(controller) {
              if (!remaining) return controller.close();
              remaining -= block.length;
              controller.enqueue(block);
            },
          });
        },
      );
      const [result] = await Promise.all([staging.receive(Readable.fromWeb(zip.readable as never)), zip.completion]);
      const stage = staging.take(result.id);
      try {
        expect(stage.byteLength).toBeGreaterThan(size);
        expect(stage.parsed.assetBlobs.size).toBe(1002);
        const source = stage.parsed.assetBlobs.get('source')!;
        expect(source).toBeInstanceOf(Blob);
        expect((source as Blob).size).toBe(size);
        expect(await hashBackupBlob(source as Blob)).toBe(digest);
        // A discard racing an already claimed restore must not delete its files.
        await staging.discard(result.id);
        expect(Buffer.from(await (source as Blob).slice(0, 3).arrayBuffer())).toEqual(Buffer.alloc(3, 123));
      } finally {
        await stage.dispose();
      }
      expect(await readdir(directory)).toEqual([]);
    });
  }, 60_000);

  it('cleans discarded/expired inspections and rejects a consumed id', async () => {
    await withStaging(async (staging, directory) => {
      const first = await receive(staging);
      await staging.discard(first.id);
      expect(() => staging.take(first.id)).toThrow('만료');
      expect(await readdir(directory)).toEqual([]);
      const second = await receive(staging);
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60_000);
      try {
        expect(() => staging.take(second.id)).toThrow('만료');
      } finally {
        clock.mockRestore();
      }
      await vi.waitFor(async () => expect(await readdir(directory)).toEqual([]));
    });
  });

  it('removes partial uploads on cancellation and rejects invalid archives without retained files', async () => {
    await withStaging(async (staging, directory) => {
      await expect(staging.receive(Readable.from(['not a zip']))).rejects.toThrow();
      expect(await readdir(directory)).toEqual([]);
      const zip = createHostedBackupStream(snapshot(), async () => Buffer.from('abc'));
      const [buffer] = await Promise.all([
        new Response(zip.readable as ReadableStream<Uint8Array<ArrayBuffer>>).arrayBuffer(),
        zip.completion,
      ]);
      const corrupted = Buffer.from(buffer);
      const position = corrupted.indexOf('abc');
      expect(position).toBeGreaterThan(0);
      corrupted[position] ^= 1;
      await expect(staging.receive(Readable.from([corrupted]))).rejects.toThrow();
      expect(await readdir(directory)).toEqual([]);
      const abort = new AbortController();
      const stream = new Readable({
        read() {
          this.push(Buffer.alloc(64 * 1024));
        },
      });
      const pending = staging.receive(stream, undefined, abort.signal);
      const timer = setTimeout(() => abort.abort(), 20);
      await expect(pending).rejects.toThrow();
      clearTimeout(timer);
      expect(stream.destroyed).toBe(true);
      expect(await readdir(directory)).toEqual([]);
    });
  });
});
