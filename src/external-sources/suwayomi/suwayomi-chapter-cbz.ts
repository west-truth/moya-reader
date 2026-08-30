const MAX_PAGE_COUNT = 5_000;
const MAX_PAGE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const PAGE_FETCH_CONCURRENCY = 4;

export interface SuwayomiChapterCbzMetadata {
  readonly title: string;
  readonly series?: string;
  readonly author?: string;
  readonly summary?: string;
  readonly language?: string;
  readonly tags?: readonly string[];
}

function xmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function imageExtension(contentType: string, url: string): string | undefined {
  const normalized = contentType.split(';', 1)[0]?.trim().toLowerCase();
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return 'jpg';
  if (normalized === 'image/png') return 'png';
  if (normalized === 'image/webp') return 'webp';
  if (normalized === 'image/gif') return 'gif';
  const match = /\.((?:jpe?g|png|webp|gif))(?:[?#]|$)/i.exec(url);
  return match?.[1]?.toLowerCase().replace('jpeg', 'jpg');
}

function comicInfo(metadata: SuwayomiChapterCbzMetadata, pageCount: number): string {
  const tagText = metadata.tags?.filter(Boolean).join(', ');
  return `<?xml version="1.0" encoding="utf-8"?>
<ComicInfo>
  <Title>${xmlText(metadata.title)}</Title>
  ${metadata.series ? `<Series>${xmlText(metadata.series)}</Series>` : ''}
  ${metadata.author ? `<Writer>${xmlText(metadata.author)}</Writer>` : ''}
  ${metadata.summary ? `<Summary>${xmlText(metadata.summary)}</Summary>` : ''}
  ${metadata.language ? `<LanguageISO>${xmlText(metadata.language)}</LanguageISO>` : ''}
  ${tagText ? `<Tags>${xmlText(tagText)}</Tags>` : ''}
  <PageCount>${pageCount}</PageCount>
  <Pages>${Array.from({ length: pageCount }, (_, image) => `<Page Image="${image}" />`).join('')}</Pages>
</ComicInfo>`;
}

export async function buildSuwayomiChapterCbz(
  pageUrls: readonly string[],
  metadata: SuwayomiChapterCbzMetadata,
  fetchPage: (url: string, signal: AbortSignal) => Promise<Response>,
  signal: AbortSignal,
): Promise<Blob> {
  if (pageUrls.length === 0) throw new Error('이 회차에는 가져올 이미지가 없습니다.');
  if (pageUrls.length > MAX_PAGE_COUNT) throw new Error('이 회차의 이미지 수가 안전 한도를 초과했습니다.');

  const { BlobReader, BlobWriter, TextReader, ZipWriter } = await import('@zip.js/zip.js');
  const output = new BlobWriter('application/vnd.comicbook+zip');
  const zip = new ZipWriter(output, { bufferedWrite: true });
  const pendingPages = new Map<number, Promise<{ readonly blob: Blob; readonly extension: string }>>();
  const fetchController = new AbortController();
  const forwardAbort = () => fetchController.abort();
  if (signal.aborted) forwardAbort();
  else signal.addEventListener('abort', forwardAbort, { once: true });
  let totalBytes = 0;
  const fetchPreparedPage = async (index: number) => {
    if (fetchController.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const url = pageUrls[index]!;
    const response = await fetchPage(url, fetchController.signal);
    const declaredLength = Number(response.headers.get('Content-Length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_PAGE_BYTES) {
      throw new Error('회차 이미지 한 장의 크기가 안전 한도를 초과했습니다.');
    }
    const blob = await response.blob();
    if (blob.size === 0 || blob.size > MAX_PAGE_BYTES) {
      throw new Error('회차 이미지 한 장의 크기가 올바르지 않습니다.');
    }
    const extension = imageExtension(blob.type || response.headers.get('Content-Type') || '', url);
    if (!extension) throw new Error('Suwayomi가 지원하지 않는 이미지 형식을 반환했습니다.');
    return { blob, extension };
  };
  const schedulePage = (index: number) => {
    if (index >= pageUrls.length) return;
    const pending = fetchPreparedPage(index);
    void pending.catch(() => undefined);
    pendingPages.set(index, pending);
  };
  try {
    await zip.add('ComicInfo.xml', new TextReader(comicInfo(metadata, pageUrls.length)));
    for (let index = 0; index < Math.min(PAGE_FETCH_CONCURRENCY, pageUrls.length); index += 1) schedulePage(index);
    for (let index = 0; index < pageUrls.length; index += 1) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const prepared = await pendingPages.get(index)!;
      pendingPages.delete(index);
      schedulePage(index + PAGE_FETCH_CONCURRENCY);
      const { blob, extension } = prepared;
      totalBytes += blob.size;
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error('회차 전체 이미지 크기가 안전 한도를 초과했습니다.');
      await zip.add(`${String(index + 1).padStart(5, '0')}.${extension}`, new BlobReader(blob), { level: 0 });
    }
    return await zip.close();
  } catch (error) {
    fetchController.abort();
    await zip.close().catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener('abort', forwardAbort);
  }
}
