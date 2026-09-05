import { describe, expect, it } from 'vitest';
import type { ExternalSourceContributionDescriptorV2 } from '@noveldesk/extension-contracts';
import type { ExternalItemSummary, ExternalSourceDownloadResult } from './contracts';
import { normalizeExternalSourceDownload, normalizeExternalSourcePage } from './source-normalization';

const profile = { kind: 'document_series', format: 'txt', encoding: 'utf-8', chapterSplitMode: 'single' } as const;
const descriptor: ExternalSourceContributionDescriptorV2 = {
  id: 'test.text',
  schemaVersion: 2,
  title: 'Text',
  kind: 'catalog',
  capabilities: ['browse', 'release-list', 'release-download', 'document-content'],
  runtimes: ['web-direct'],
  seriesProfile: profile,
};
const key = { connectorId: descriptor.id, accountConnectionId: 'account', remoteId: 'release' };
const item: ExternalItemSummary = {
  key,
  kind: 'file',
  title: '1화',
  importability: 'supported',
  collection: { remoteId: 'work', title: '작품', seriesProfile: profile },
  release: { title: '1화' },
};
const content = (file: File) =>
  ({ kind: 'document', file, format: 'txt', encoding: 'utf-8', chapterSplitMode: 'single' }) as const;
const normalize = (result: ExternalSourceDownloadResult, maxBytes?: number) =>
  normalizeExternalSourceDownload(
    descriptor,
    result,
    { key, fileName: '1화.txt', context: { expectedProfile: profile, maxBytes } },
    new AbortController().signal,
  );

describe('external source normalization', () => {
  it('preserves exact UTF-8 bytes and exposes the same File through legacy and typed fields', async () => {
    const file = new File(['\ufeff제목\r\n\u00a0 문단  \n\n'], '1화.txt', { type: 'text/plain;charset=utf-8' });
    const result = await normalize({ content: content(file), remoteRevision: 'r1' });
    expect(result.file).toBe(file);
    expect(result.content.file).toBe(file);
    expect(result.remoteRevision).toBe('r1');
    expect(await result.file.arrayBuffer()).toEqual(await file.arrayBuffer());
  });

  it('rejects mismatched, empty, unsafe, oversized and non-UTF-8 documents before import', async () => {
    for (const file of [
      new File([], 'chapter.txt'),
      new File(['text'], '../chapter.txt'),
      new File(['text'], 'chapter\u001f.txt'),
      new File(['text'], 'chapter.html'),
      new File([new Uint8Array([0xff])], 'chapter.txt'),
      new File(['\0binary'], 'chapter.txt'),
      new File(['text'], 'chapter.txt', { type: 'text/html' }),
    ])
      await expect(normalize({ content: content(file) })).rejects.toThrow('외부 소스');
    await expect(normalize({ content: content(new File(['abcd'], 'chapter.txt')) }, 3)).rejects.toThrow('크기');
    await expect(normalize({ file: new File(['text'], 'chapter.txt') })).rejects.toThrow('콘텐츠 형식');
    await expect(
      normalize({ content: { kind: 'standalone_file', file: new File(['text'], 'chapter.txt') } }),
    ).rejects.toThrow('형식');
  });

  it('preserves v1 standalone and CBZ while keeping ambiguous serial items unsupported', async () => {
    const legacy = { ...descriptor, schemaVersion: 1, capabilities: ['browse', 'file-download'] } as const;
    const file = new File(['standalone text'], 'standalone.txt');
    const result = await normalizeExternalSourceDownload(
      legacy,
      { file },
      { key, fileName: file.name },
      new AbortController().signal,
    );
    expect(result.content.kind).toBe('standalone_file');
    expect(result.file).toBe(file);
    const page = normalizeExternalSourcePage(
      legacy,
      {
        items: [
          { ...item, collection: { remoteId: 'work', title: 'Work' }, mimeType: 'application/vnd.comicbook+zip' },
          { ...item, collection: { remoteId: 'other', title: 'Other' }, mimeType: 'application/octet-stream' },
        ],
      },
      'account',
    );
    expect(page.items[0]?.collection?.seriesProfile).toEqual({ kind: 'image_series', archiveFormat: 'cbz' });
    expect(page.items[1]?.importability).toBe('unsupported');
    const cbz = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'chapter.cbz', {
      type: 'application/vnd.comicbook+zip',
    });
    const archive = await normalizeExternalSourceDownload(
      legacy,
      { file: cbz },
      {
        key,
        fileName: cbz.name,
        context: { expectedProfile: { kind: 'image_series', archiveFormat: 'cbz' } },
      },
      new AbortController().signal,
    );
    expect(archive.content.kind).toBe('image_archive');
    expect(archive.file).toBe(cbz);
  });

  it('rejects wrong account, missing profile and mixed collection profiles on catalog normalization', () => {
    expect(
      normalizeExternalSourcePage(descriptor, { items: [item] }, 'account').items[0]?.collection?.seriesProfile,
    ).toEqual(profile);
    expect(() => normalizeExternalSourcePage(descriptor, { items: [item] }, 'other')).toThrow('연결 정보');
    expect(() =>
      normalizeExternalSourcePage(
        descriptor,
        { items: [{ ...item, collection: { remoteId: 'work', title: 'Work' } }] },
        'account',
      ),
    ).toThrow('형식');
    const mixedDescriptor = {
      ...descriptor,
      seriesProfile: undefined,
      capabilities: [...descriptor.capabilities, 'image-content'],
    } as const;
    expect(() =>
      normalizeExternalSourcePage(
        mixedDescriptor,
        {
          items: [
            item,
            {
              ...item,
              collection: { ...item.collection!, seriesProfile: { kind: 'image_series', archiveFormat: 'cbz' } },
            },
          ],
        },
        'account',
      ),
    ).toThrow('형식');
  });

  it('checks cancellation again after asynchronous body validation', async () => {
    const abort = new AbortController();
    const file = new File(['body'], 'chapter.txt');
    Object.defineProperty(file, 'arrayBuffer', {
      value: async () => {
        abort.abort();
        return new TextEncoder().encode('body').buffer;
      },
    });
    await expect(
      normalizeExternalSourceDownload(
        descriptor,
        { content: content(file) },
        {
          key,
          fileName: file.name,
          context: { expectedProfile: profile },
        },
        abort.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
