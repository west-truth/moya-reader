import { createHash } from 'node:crypto';
import { TextReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { describe, expect, it } from 'vitest';
import {
  createHostedBackupStream,
  HOSTED_BACKUP_FORMAT,
  HOSTED_BACKUP_VERSION,
  MAX_HOSTED_BACKUP_ENTRIES,
  MAX_HOSTED_BACKUP_UNCOMPRESSED_BYTES,
  parseHostedBackupArchive,
  type HostedBackupSnapshot,
  type HostedBookObjectRow,
} from './hosted-backup-archive.js';

function hash(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    chunks.push(result.value);
    total += result.value.byteLength;
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function archiveWithVoiceCastingRows(rows: readonly Record<string, unknown>[]): Promise<Uint8Array> {
  const values = new Map<string, unknown>([
    ['hosted/tables/library_books.json', []],
    ['hosted/tables/reader_settings.json', []],
    ['hosted/tables/voice_casting_states.json', rows],
    ['hosted/book_objects.json', []],
  ]);
  const entries = Array.from(values, ([path, value]) => {
    const text = JSON.stringify(value);
    return {
      path,
      text,
      contentHash: hash(Buffer.from(text)),
      byteLength: Buffer.byteLength(text),
      contentType: 'application/json',
    };
  });
  const manifest = {
    format: HOSTED_BACKUP_FORMAT,
    version: HOSTED_BACKUP_VERSION,
    exportedAt: '2026-07-13T00:00:00.000Z',
    appVersion: '0.1.0',
    books: [],
    entries: entries.map(({ text: _text, ...entry }) => entry),
    assetBlobs: [],
    backend: 'hosted',
  };
  const output = new Uint8ArrayWriter();
  const zip = new ZipWriter(output);
  for (const entry of entries) await zip.add(entry.path, new TextReader(entry.text));
  await zip.add('manifest.json', new TextReader(JSON.stringify(manifest)));
  return zip.close();
}

describe('hosted backup archive', () => {
  it('streams and validates table snapshots with exact source bytes', async () => {
    const source = Buffer.from('exact hosted source');
    const cover = Buffer.from('exact hosted cover');
    const object: HostedBookObjectRow = {
      id: 'object_1',
      raw_text_hash: hash(source),
      storage_key: 'user/object_1/book.txt',
      file_name: 'book.txt',
      content_type: 'text/plain',
      size_bytes: source.byteLength,
      created_at: '2026-07-13T00:00:00.000Z',
    };
    const coverObject: HostedBookObjectRow = {
      id: 'cover_1',
      raw_text_hash: hash(cover),
      storage_key: 'user/book_1/covers/cover_1/cover.webp',
      file_name: 'cover.webp',
      content_type: 'image/webp',
      size_bytes: cover.byteLength,
      created_at: '2026-07-13T00:00:01.000Z',
      asset_kind: 'cover',
    };
    const snapshot: HostedBackupSnapshot = {
      tables: new Map([
        [
          'library_books',
          [
            {
              id: 'book_1',
              user_id: 'user_1',
              object_id: object.id,
              title: 'Book',
              active_content_revision_id: 'revision_1',
              cover_asset_id: coverObject.id,
            },
          ],
        ],
        [
          'book_assets',
          [
            {
              id: coverObject.id,
              user_id: 'user_1',
              book_id: 'book_1',
              kind: 'cover',
              status: 'active',
              storage_key: coverObject.storage_key,
              content_hash: coverObject.raw_text_hash,
            },
          ],
        ],
        [
          'voice_casting_states',
          [
            {
              user_id: 'user_1',
              book_id: 'book_1',
              version: 'voice-casting-v1',
              revision: 2,
              state_payload: { status: 'active' },
              user_authored_payload: { voiceProfileIds: ['voice_1'], pools: [], overrides: [], traitEvidence: [] },
              derived_payload: { automaticAssignments: [] },
            },
          ],
        ],
        ['reader_settings', [{ user_id: 'user_1', settings: { theme: 'dark' } }]],
      ]),
      objects: [object, coverObject],
      books: [{ id: 'book_1', format: 'txt', activeContentRevisionId: 'revision_1', title: 'Book' }],
      exportedAt: '2026-07-13T00:00:00.000Z',
      appVersion: '0.1.0',
    };

    const streamed = createHostedBackupStream(snapshot, async (item) => (item.id === coverObject.id ? cover : source));
    const [archive] = await Promise.all([collect(streamed.readable), streamed.completion]);
    const parsed = await parseHostedBackupArchive(archive);

    expect(parsed.manifest).toMatchObject({ backend: 'hosted', books: [{ id: 'book_1', title: 'Book' }] });
    expect(parsed.tables.get('library_books')).toEqual(snapshot.tables.get('library_books'));
    expect(parsed.assetBlobs.get('object_1')).toEqual(source);
    expect(parsed.tables.get('book_assets')).toEqual(snapshot.tables.get('book_assets'));
    expect(parsed.tables.get('voice_casting_states')).toEqual(snapshot.tables.get('voice_casting_states'));
    expect(parsed.assetBlobs.get('cover_1')).toEqual(cover);
  });

  it('rejects secret-like voice casting projection values on export and import', async () => {
    const unsafeRow = {
      user_id: 'user_1',
      book_id: 'book_1',
      version: 'voice-casting-v1',
      revision: 1,
      state_payload: {},
      user_authored_payload: { apiKey: 'sk-proj-secret-value' },
      derived_payload: {},
    };
    const snapshot: HostedBackupSnapshot = {
      tables: new Map([
        ['library_books', []],
        ['voice_casting_states', [unsafeRow]],
        ['reader_settings', []],
      ]),
      objects: [],
      books: [],
      exportedAt: '2026-07-13T00:00:00.000Z',
      appVersion: '0.1.0',
    };

    expect(() => createHostedBackupStream(snapshot, async () => Buffer.alloc(0))).toThrow(/secret-like/i);
    await expect(parseHostedBackupArchive(await archiveWithVoiceCastingRows([unsafeRow]))).rejects.toThrow(
      /secret-like/i,
    );
  });

  it('fails export when object storage bytes do not match metadata', async () => {
    const source = Buffer.from('expected');
    const object: HostedBookObjectRow = {
      id: 'object_1',
      raw_text_hash: hash(source),
      storage_key: 'object',
      file_name: 'book.txt',
      content_type: 'text/plain',
      size_bytes: source.byteLength,
      created_at: '2026-07-13T00:00:00.000Z',
    };
    const streamed = createHostedBackupStream(
      {
        tables: new Map([
          ['library_books', []],
          ['reader_settings', []],
        ]),
        objects: [object],
        books: [],
        exportedAt: '2026-07-13T00:00:00.000Z',
        appVersion: '0.1.0',
      },
      async () => Buffer.from('wrong'),
    );
    const consumption = collect(streamed.readable).catch(() => new Uint8Array());
    await expect(streamed.completion).rejects.toThrow('integrity check failed');
    await consumption;
  });

  it('rejects exports whose declared size cannot be accepted by restore', () => {
    const object: HostedBookObjectRow = {
      id: 'object_oversized',
      raw_text_hash: hash(Buffer.alloc(0)),
      storage_key: 'object',
      file_name: 'book.bin',
      content_type: 'application/octet-stream',
      size_bytes: MAX_HOSTED_BACKUP_UNCOMPRESSED_BYTES,
      created_at: '2026-07-13T00:00:00.000Z',
    };
    expect(() =>
      createHostedBackupStream(
        {
          tables: new Map([
            ['library_books', []],
            ['reader_settings', []],
          ]),
          objects: [object],
          books: [],
          exportedAt: '2026-07-13T00:00:00.000Z',
          appVersion: '0.1.0',
        },
        async () => Buffer.alloc(0),
      ),
    ).toThrow('too large to restore');
  });

  it('counts manifest.json when enforcing the restore entry limit', () => {
    const objectCount = MAX_HOSTED_BACKUP_ENTRIES - 3;
    const objects = Array.from({ length: objectCount }, (_, index): HostedBookObjectRow => ({
      id: `object_${index}`,
      raw_text_hash: hash(Buffer.alloc(0)),
      storage_key: `object_${index}`,
      file_name: 'book.bin',
      content_type: 'application/octet-stream',
      size_bytes: 0,
      created_at: '2026-07-13T00:00:00.000Z',
    }));
    expect(() =>
      createHostedBackupStream(
        {
          tables: new Map([
            ['library_books', []],
            ['reader_settings', []],
          ]),
          objects,
          books: [],
          exportedAt: '2026-07-13T00:00:00.000Z',
          appVersion: '0.1.0',
        },
        async () => Buffer.alloc(0),
      ),
    ).toThrow('entry count is outside');
  });
});
