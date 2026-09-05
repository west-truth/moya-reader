import { describe, expect, it } from 'vitest';
import { integrityHash } from '@noveldesk/text-core/hash';
import { materializeDocumentSeriesArchive, readDocumentSeriesArchive } from '@noveldesk/document-series-core';
import type { ExternalSourceCollectionDescriptorV2 } from '../contracts';
import {
  assembleDocumentSeries,
  type AssembleDocumentSeriesInput,
  type ExternalDocumentSeriesReleaseInput,
} from './document-series-assembler';
import { externalDocumentCollectionId, externalDocumentReleaseSourceId } from './document-series-identity';

const collection: ExternalSourceCollectionDescriptorV2 = {
  remoteId: 'work-1',
  title: 'Fixture work',
  seriesProfile: { kind: 'document_series', format: 'txt', encoding: 'utf-8', chapterSplitMode: 'single' },
};
function release(id: string, body: string, order: number, title = id): ExternalDocumentSeriesReleaseInput {
  return {
    item: {
      key: { connectorId: 'fixture.text', accountConnectionId: 'account-1', remoteId: id },
      kind: 'file',
      title,
      collection,
      release: { title, sourceOrder: order },
      importability: 'supported',
    },
    content: {
      kind: 'document',
      file: new File([body], `${id}.txt`, { type: 'text/plain' }),
      format: 'txt',
      encoding: 'utf-8',
      chapterSplitMode: 'single',
    },
    sourceContentHash: integrityHash(new TextEncoder().encode(body)),
  };
}
function input(releases: ExternalDocumentSeriesReleaseInput[], existing?: File): AssembleDocumentSeriesInput {
  return {
    collection,
    releases,
    targetBookId: 'target-book',
    existingSource: existing ? { blob: existing } : undefined,
    expectedBase: existing ? { kind: 'revision', contentRevisionId: 'revision-1' } : { kind: 'absent' },
    signal: new AbortController().signal,
  };
}

describe('external document series assembler', () => {
  it('preserves exact release bytes and combines single chapters without splitting body headings', async () => {
    const first = release('release-1', '# Body heading\r\n\r\nFirst body.\r\n\r\n1장\r\nMore body.\r\n', 1);
    const result = await assembleDocumentSeries(input([first, release('release-2', 'Second body.', 2)]));
    expect(result.change).toBe('content');
    expect(result.expectedBase).toEqual({ kind: 'absent' });
    const archive = (await readDocumentSeriesArchive(result.file!))!;
    const sourceId = externalDocumentReleaseSourceId(first.item.key, collection.remoteId);
    expect(await archive.sources.get(sourceId)!.arrayBuffer()).toEqual(await first.content.file.arrayBuffer());
    const parsed = await materializeDocumentSeriesArchive(result.file!, {
      fileName: result.file!.name,
      clientBookId: 'target-book',
    });
    expect(parsed.chapters).toHaveLength(2);
    expect(parsed.chapters.map((chapter) => chapter.title)).toEqual(['release-1', 'release-2']);
    expect(result.releaseProjections[0]).toEqual({
      remoteId: 'release-1',
      sourceId,
      sourceContentHash: first.sourceContentHash,
      previousSourceContentHash: null,
    });
  });

  it('reuses originals for title and order changes, skips delivery-only drift, and replaces exact bytes under one source ID', async () => {
    const first = release('release-1', 'Original.', 1);
    const second = release('release-2', 'Other.', 2);
    const initial = await assembleDocumentSeries(input([first, second]));
    const unchanged = await assembleDocumentSeries(
      input(
        [
          {
            ...first,
            remoteRevision: 'new-check',
            content: { ...first.content, file: new File(['Original.'], 'renamed.txt') },
          },
        ],
        initial.file,
      ),
    );
    expect(unchanged).toMatchObject({ change: 'none', configurationFingerprint: initial.configurationFingerprint });
    expect(unchanged.file).toBeUndefined();
    const changedConfig = await assembleDocumentSeries(
      input([release('release-1', 'Original.', 3, 'New title')], initial.file),
    );
    expect(changedConfig.change).toBe('configuration');
    expect(changedConfig.configurationFingerprint).not.toBe(initial.configurationFingerprint);
    const parsed = await materializeDocumentSeriesArchive(changedConfig.file!, {
      fileName: changedConfig.file!.name,
      clientBookId: 'target-book',
    });
    expect(parsed.chapters.map((chapter) => chapter.title)).toEqual(['release-2', 'New title']);
    const revised = await assembleDocumentSeries(
      input(
        [{ ...release('release-1', 'Revised.', 1), expectedPreviousSourceContentHash: first.sourceContentHash }],
        initial.file,
      ),
    );
    const archive = (await readDocumentSeriesArchive(revised.file!))!;
    expect(revised.change).toBe('content');
    expect(archive.manifest.sources).toHaveLength(2);
    expect(
      await archive.sources.get(externalDocumentReleaseSourceId(first.item.key, collection.remoteId))!.text(),
    ).toBe('Revised.');
    expect(
      await archive.sources.get(externalDocumentReleaseSourceId(second.item.key, collection.remoteId))!.text(),
    ).toBe('Other.');
  });

  it('rejects stale release bytes, mixed account scope, invalid UTF-8 and cancellation before creating an aggregate', async () => {
    const first = release('release-1', 'Original.', 1);
    const initial = await assembleDocumentSeries(input([first]));
    await expect(
      assembleDocumentSeries(
        input(
          [{ ...release('release-1', 'Revised.', 1), expectedPreviousSourceContentHash: integrityHash('unexpected') }],
          initial.file,
        ),
      ),
    ).rejects.toThrow('기존 본문');
    const other = release('release-2', 'Other.', 2);
    await expect(
      assembleDocumentSeries(
        input([
          first,
          { ...other, item: { ...other.item, key: { ...other.item.key, accountConnectionId: 'other-account' } } },
        ]),
      ),
    ).rejects.toThrow('연결');
    const invalid = new File([new Uint8Array([0xc3, 0x28])], 'invalid.txt');
    await expect(
      assembleDocumentSeries(input([{ ...first, content: { ...first.content, file: invalid } }])),
    ).rejects.toThrow();
    const abort = new AbortController();
    abort.abort();
    await expect(assembleDocumentSeries({ ...input([first]), signal: abort.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('scopes persistent IDs with tuples rather than ambiguous delimiter strings', () => {
    expect(externalDocumentCollectionId({ connectorId: 'a:b', accountConnectionId: 'c' }, 'd')).not.toBe(
      externalDocumentCollectionId({ connectorId: 'a', accountConnectionId: 'b:c' }, 'd'),
    );
    expect(
      externalDocumentReleaseSourceId({ connectorId: 'a', accountConnectionId: 'b', remoteId: 'c:d' }, 'e'),
    ).not.toBe(externalDocumentReleaseSourceId({ connectorId: 'a', accountConnectionId: 'b', remoteId: 'd' }, 'e:c'));
  });
});
