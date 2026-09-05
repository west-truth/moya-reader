import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { integrityHash } from '@noveldesk/text-core/hash';
import { parseDecodedNovelTextForImportCooperatively } from '../services/import/cooperative-import-parser';
import { runBrowserImportPipeline } from '../services/import/browser-import-pipeline';
import type { ImportExpectedBase } from '../services/import/import-service';
import { getNovel, resetReaderDbForTests, saveParsedNovelImport } from '../storage/db';

afterEach(() => resetReaderDbForTests());
const bytes = (body: string) => new TextEncoder().encode(body).buffer;
const parse = (body: string) =>
  parseDecodedNovelTextForImportCooperatively(
    'fixture.txt',
    { text: body, encoding: 'utf-8' },
    integrityHash(new Uint8Array(bytes(body))),
    { clientBookId: 'fenced-book', yieldControl: async () => undefined },
  );

describe('local caller snapshot fence', () => {
  it('carries an absent fence through the TXT pipeline and rejects identical bytes on an existing book', async () => {
    const input = {
      jobId: 'fixture',
      fileName: 'fixture.txt',
      buffer: bytes('original body'),
      totalBytes: 13,
      encoding: 'utf-8' as const,
      clientBookId: 'fenced-book',
      expectedBase: { kind: 'absent' } as const,
      onProgress: () => undefined,
      yieldControl: async () => undefined,
    };
    await runBrowserImportPipeline(input);
    const before = await getNovel('fenced-book');
    await expect(runBrowserImportPipeline({ ...input, buffer: bytes('original body') })).rejects.toMatchObject({
      name: 'ContentRevisionConflictError',
    });
    expect((await getNovel('fenced-book'))?.activeContentRevisionId).toBe(before?.activeContentRevisionId);
  });

  it('accepts the captured revision once and rejects a stale same-payload retry', async () => {
    await saveParsedNovelImport(await parse('original body'));
    const expectedBase: ImportExpectedBase = {
      kind: 'revision',
      contentRevisionId: (await getNovel('fenced-book'))!.activeContentRevisionId!,
    };
    await saveParsedNovelImport(await parse('changed body'), { expectedBase });
    const latest = await getNovel('fenced-book');
    expect(latest!.activeContentRevisionId).not.toBe(expectedBase.contentRevisionId);
    await expect(saveParsedNovelImport(await parse('changed body'), { expectedBase })).rejects.toMatchObject({
      name: 'ContentRevisionConflictError',
    });
    expect((await getNovel('fenced-book'))?.activeContentRevisionId).toBe(latest?.activeContentRevisionId);
  });

  it.each(['absent', 'revision'] as const)(
    'rechecks %s at activation against another import committed after staging',
    async (kind) => {
      if (kind === 'revision') await saveParsedNovelImport(await parse('initial body'));
      const expectedBase: ImportExpectedBase =
        kind === 'absent'
          ? { kind }
          : { kind, contentRevisionId: (await getNovel('fenced-book'))!.activeContentRevisionId! };
      let interveningRevision: string | undefined;
      await expect(
        saveParsedNovelImport(await parse('stale body'), {
          expectedBase,
          onProgress: async (progress) => {
            if (progress.phase !== 'activating_revision' || interveningRevision) return;
            await saveParsedNovelImport(await parse('intervening replacement'));
            interveningRevision = (await getNovel('fenced-book'))?.activeContentRevisionId;
          },
        }),
      ).rejects.toMatchObject({ name: 'ContentRevisionConflictError' });
      expect(interveningRevision).toBeTruthy();
      expect((await getNovel('fenced-book'))?.activeContentRevisionId).toBe(interveningRevision);
    },
  );
});
