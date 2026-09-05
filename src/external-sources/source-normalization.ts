import {
  isExternalSeriesProfile,
  type ExternalSourceContributionDescriptor,
  type ExternalSeriesProfile,
} from '@noveldesk/extension-contracts';
import type {
  ExternalItemPage,
  ExternalItemSummary,
  ExternalSourceContent,
  ExternalSourceDownloadRef,
  ExternalSourceDownloadResult,
  NormalizedDownloadedExternalSource,
} from './contracts';

const MAX_TEXT_RELEASE_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const MAX_V2_PAGE_ITEMS = 1_000;

function invalid(message: string): never {
  // Do not include provider payloads, URLs or credentials in diagnostics.
  throw new Error(`외부 소스 응답이 올바르지 않습니다. ${message}`);
}

function sameProfile(left: ExternalSeriesProfile, right: ExternalSeriesProfile): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'document_series') return true; // Only UTF-8 TXT single is supported.
  return (
    right.kind === 'image_series' &&
    left.archiveFormat === right.archiveFormat &&
    left.readingDirection === right.readingDirection
  );
}

function descriptorProfile(descriptor: ExternalSourceContributionDescriptor): ExternalSeriesProfile | undefined {
  return descriptor.schemaVersion === 2 ? descriptor.seriesProfile : undefined;
}

function requireProfileCapability(
  descriptor: ExternalSourceContributionDescriptor,
  profile: ExternalSeriesProfile,
): void {
  if (descriptor.schemaVersion !== 2) return;
  if (
    !descriptor.capabilities.includes('release-download') ||
    !descriptor.capabilities.includes(profile.kind === 'document_series' ? 'document-content' : 'image-content')
  ) {
    invalid('선언한 콘텐츠 기능과 회차 형식이 다릅니다.');
  }
  const restriction = descriptorProfile(descriptor);
  if (restriction && !sameProfile(restriction, profile)) invalid('소스와 작품의 연재 형식이 다릅니다.');
}

function legacyImageProfile(item: ExternalItemSummary): ExternalSeriesProfile | undefined {
  const mime = item.mimeType?.split(';')[0]?.trim().toLowerCase();
  const hint = item.formatHint?.trim().toLowerCase();
  if (mime === 'application/vnd.comicbook+zip' || hint === 'cbz') {
    return { kind: 'image_series', archiveFormat: 'cbz' };
  }
  return undefined;
}

/** v1 unknown serial formats stay visible but cannot enter the image assembler. */
export function normalizeExternalSourcePage(
  descriptor: ExternalSourceContributionDescriptor,
  page: ExternalItemPage,
  accountConnectionId?: string,
): ExternalItemPage {
  if (!page || !Array.isArray(page.items)) invalid('목록 형식을 확인해 주세요.');
  if (descriptor.schemaVersion === 2 && page.items.length > MAX_V2_PAGE_ITEMS)
    invalid('목록 크기 한도를 초과했습니다.');
  const profiles = new Map<string, ExternalSeriesProfile>();
  return {
    ...page,
    items: page.items.map((item) => {
      if (
        !item?.key ||
        item.key.connectorId !== descriptor.id ||
        (item.key.accountConnectionId ?? '') !== (accountConnectionId ?? '') ||
        typeof item.key.remoteId !== 'string' ||
        !item.key.remoteId.trim()
      )
        invalid('목록의 연결 정보가 다릅니다.');
      if (!item.release) return item;
      if (!item.collection?.remoteId) invalid('회차의 작품 정보가 없습니다.');
      const profile = descriptor.schemaVersion === 2 ? item.collection.seriesProfile : legacyImageProfile(item);
      if (!profile) {
        if (descriptor.schemaVersion === 2) invalid('회차의 연재 형식이 없습니다.');
        return { ...item, importability: 'unsupported' as const };
      }
      if (!isExternalSeriesProfile(profile)) invalid('지원하지 않는 연재 형식입니다.');
      requireProfileCapability(descriptor, profile);
      const previous = profiles.get(item.collection.remoteId);
      if (previous && !sameProfile(previous, profile)) invalid('같은 작품의 회차 형식이 다릅니다.');
      profiles.set(item.collection.remoteId, profile);
      return { ...item, collection: { ...item.collection, seriesProfile: profile } };
    }),
  };
}

function validateFile(file: File, maxBytes: number): void {
  if (!(file instanceof File) || file.size <= 0 || file.size > maxBytes)
    invalid('파일 크기가 안전 한도를 벗어났습니다.');
  const hasControl = Array.from(file.name).some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
  if (!file.name.trim() || /[\\/:]/u.test(file.name) || hasControl || file.name === '.' || file.name === '..') {
    invalid('파일 이름을 사용할 수 없습니다.');
  }
}

/** Bytes remain unchanged; decoding verifies UTF-8 and never re-encodes the artifact. */
export async function normalizeExternalSourceDownload(
  descriptor: ExternalSourceContributionDescriptor,
  result: ExternalSourceDownloadResult,
  ref: ExternalSourceDownloadRef,
  signal: AbortSignal,
): Promise<NormalizedDownloadedExternalSource> {
  signal.throwIfAborted();
  const expected = ref.context?.expectedProfile ?? descriptorProfile(descriptor);
  if (expected && !isExternalSeriesProfile(expected)) invalid('지원하지 않는 예상 회차 형식입니다.');
  if (expected) requireProfileCapability(descriptor, expected);
  let content = result?.content;
  if (!content) {
    if (descriptor.schemaVersion === 2 || !result || !('file' in result)) invalid('콘텐츠 형식이 없습니다.');
    content =
      expected?.kind === 'image_series'
        ? { kind: 'image_archive', file: result.file, format: expected.archiveFormat }
        : expected?.kind === 'document_series'
          ? { kind: 'document', file: result.file, format: 'txt', encoding: 'utf-8', chapterSplitMode: 'single' }
          : { kind: 'standalone_file', file: result.file };
  }
  if (!['document', 'image_archive', 'standalone_file'].includes(content.kind))
    invalid('지원하지 않는 콘텐츠 형식입니다.');
  const hardLimit = content.kind === 'document' ? MAX_TEXT_RELEASE_BYTES : MAX_FILE_BYTES;
  const requestedLimit = ref.context?.maxBytes;
  if (requestedLimit !== undefined && (!Number.isSafeInteger(requestedLimit) || requestedLimit <= 0))
    invalid('파일 크기 제한이 올바르지 않습니다.');
  validateFile(content.file, Math.min(hardLimit, requestedLimit ?? hardLimit));
  if ('file' in result && result.file !== content.file) invalid('콘텐츠 원본이 일치하지 않습니다.');
  if (
    expected &&
    (expected.kind === 'document_series' ? content.kind !== 'document' : content.kind !== 'image_archive')
  ) {
    invalid('요청한 회차와 받은 콘텐츠 형식이 다릅니다.');
  }
  if (
    descriptor.schemaVersion === 2 &&
    content.kind !== 'standalone_file' &&
    !descriptor.capabilities.includes(content.kind === 'document' ? 'document-content' : 'image-content')
  ) {
    invalid('선언하지 않은 콘텐츠 형식입니다.');
  }
  const mime = content.file.type.split(';')[0]?.trim().toLowerCase();
  if (content.kind === 'document') {
    if (
      content.format !== 'txt' ||
      content.encoding !== 'utf-8' ||
      content.chapterSplitMode !== 'single' ||
      !/\.txt$/iu.test(content.file.name) ||
      !['', 'text/plain', 'application/octet-stream'].includes(mime ?? '')
    ) {
      invalid('UTF-8 TXT 단일 회차만 지원합니다.');
    }
    const bytes = await content.file.arrayBuffer();
    signal.throwIfAborted();
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      invalid('UTF-8 본문을 읽을 수 없습니다.');
    }
    if (!text.trim() || text.includes('\0')) invalid('본문이 비어 있거나 텍스트 형식이 아닙니다.');
  } else if (content.kind === 'image_archive') {
    if (
      !['cbz', 'zip'].includes(content.format) ||
      !new RegExp(`\\.${content.format}$`, 'iu').test(content.file.name) ||
      ![
        '',
        'application/zip',
        'application/x-zip-compressed',
        'application/vnd.comicbook+zip',
        'application/octet-stream',
      ].includes(mime ?? '') ||
      (expected?.kind === 'image_series' && expected.archiveFormat !== content.format)
    )
      invalid('이미지 압축 형식이 다릅니다.');
    const header = new Uint8Array(await content.file.slice(0, 4).arrayBuffer());
    signal.throwIfAborted();
    if (header[0] !== 0x50 || header[1] !== 0x4b || header[2] !== 0x03 || header[3] !== 0x04)
      invalid('유효한 ZIP 원본이 아닙니다.');
    // Entry/image/decompression validation remains owned by the existing image importer.
  }
  signal.throwIfAborted();
  return { file: content.file, content: content as ExternalSourceContent, remoteRevision: result.remoteRevision };
}
