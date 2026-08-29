import {
  MOYA_EXTENSION_API_VERSION,
  MOYA_EXTENSION_MANIFEST_VERSION,
  type ExtensionManifestV1,
} from '@noveldesk/extension-contracts';
import type { BookEnrichmentCandidateDraft } from '../../features/book-enrichment/book-enrichment-contract';
import { integrityHash } from '../../domain/id-hash-contract';
import type { TrustedAnalysisWorkflowHostContext } from '../analysis-workflow-host-context';
import type { TrustedReaderAddonHostContext } from '../reader-addon-host-context';
import type { TrustedExtensionDefinition } from '../trusted-extension-registry';

export const LIBRARY_BOOK_ENRICHMENT_EXTENSION_ID = 'moya.library.enrichment' as const;
export const LIBRARY_BOOK_ENRICHMENT_PROVIDER_ID = 'moya.library.enrichment.filename-and-cover' as const;

const manifest = {
  manifestVersion: MOYA_EXTENSION_MANIFEST_VERSION,
  id: LIBRARY_BOOK_ENRICHMENT_EXTENSION_ID,
  name: 'Moya library enrichment',
  version: '1.0.0',
  engine: { moyaApi: MOYA_EXTENSION_API_VERSION },
  permissions: ['book.enrichment.propose'],
  contributes: {
    bookEnrichmentProviders: [
      {
        id: LIBRARY_BOOK_ENRICHMENT_PROVIDER_ID,
        schemaVersion: 1,
        title: '파일명·기본 표지 추천',
        description: '파일명에서 빠진 작품 정보를 찾고, 표지가 없으면 로컬 기본 표지를 제안합니다.',
        capabilities: ['metadata', 'cover'],
        order: 10,
      },
    ],
  },
} as const satisfies ExtensionManifestV1;

function cleanFileStem(fileName?: string): string | undefined {
  if (!fileName) return undefined;
  const lastSegment = fileName.split(/[\\/]/u).at(-1) ?? fileName;
  return lastSegment.replace(/\.(?:txt|md|markdown|epub|pdf|cbz|cbr|zip|rar|7z)$/iu, '').trim();
}

function proposedMetadata(
  book: import('../../features/book-enrichment/book-enrichment-contract').PublicBookMetadataSnapshot,
) {
  const stem = cleanFileStem(book.sourceFileName);
  if (!stem) return undefined;
  const trimmedStem = stem.trim();
  const closingBracket = trimmedStem.startsWith('[') ? ']' : trimmedStem.startsWith('【') ? '】' : undefined;
  const closingIndex = closingBracket ? trimmedStem.indexOf(closingBracket, 1) : -1;
  const inferredAuthor = closingIndex > 1 ? trimmedStem.slice(1, closingIndex).trim() : undefined;
  const titleSource = closingIndex > 1 ? trimmedStem.slice(closingIndex + 1) : stem;
  const inferredTitle = titleSource
    .replace(/[_＿]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  const patch: import('../../features/book-enrichment/book-enrichment-contract').BookEnrichmentMetadataValues = {};
  if (inferredTitle && inferredTitle !== book.title.trim()) Object.assign(patch, { title: inferredTitle });
  if (!book.author && inferredAuthor) Object.assign(patch, { author: inferredAuthor });
  if (!book.language) {
    const hangul = [...`${inferredTitle}${inferredAuthor ?? ''}`].filter((character) =>
      /[가-힣]/u.test(character),
    ).length;
    if (hangul >= 2) Object.assign(patch, { language: 'ko-KR' });
  }
  return Object.keys(patch).length > 0
    ? ({
        kind: 'metadata',
        patch,
        rationale: '가져온 파일명의 대괄호 저자 표기와 파일 확장자를 정리했습니다.',
        sourceFingerprints: [`source-file-name:${integrityHash(new TextEncoder().encode(stem))}`],
      } as const)
    : undefined;
}

function wrapTitle(context: CanvasRenderingContext2D, title: string, maxWidth: number): string[] {
  const chunks = title.includes(' ') ? title.split(/\s+/u) : [...title];
  const lines: string[] = [];
  let line = '';
  for (const chunk of chunks) {
    const next = line ? `${line}${title.includes(' ') ? ' ' : ''}${chunk}` : chunk;
    if (line && context.measureText(next).width > maxWidth) {
      lines.push(line);
      line = chunk;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 6);
}

async function proposedCover(
  book: import('../../features/book-enrichment/book-enrichment-contract').PublicBookMetadataSnapshot,
): Promise<BookEnrichmentCandidateDraft | undefined> {
  if (book.cover.present || typeof document === 'undefined') return undefined;
  const canvas = document.createElement('canvas');
  canvas.width = 720;
  canvas.height = 1080;
  const context = canvas.getContext('2d');
  if (!context) return undefined;
  const hue = [...book.bookId].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 360;
  const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
  gradient.addColorStop(0, `hsl(${hue} 38% 24%)`);
  gradient.addColorStop(1, `hsl(${(hue + 48) % 360} 45% 12%)`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = 'rgba(255,255,255,0.12)';
  context.fillRect(62, 62, 596, 956);
  context.fillStyle = '#fffaf0';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.font = '700 64px serif';
  const lines = wrapTitle(context, book.title, 540);
  const lineHeight = 84;
  const startY = 510 - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((line, index) => context.fillText(line, 360, startY + index * lineHeight));
  if (book.author) {
    context.font = '400 28px sans-serif';
    context.fillStyle = 'rgba(255,250,240,0.82)';
    context.fillText(book.author, 360, 860);
  }
  const binary = await new Promise<Blob | undefined>((resolve) =>
    canvas.toBlob((blob) => resolve(blob ?? undefined), 'image/png'),
  );
  if (!binary) return undefined;
  const derivationFingerprint = integrityHash(
    new TextEncoder().encode(`moya-cover-v1\u0000${book.bookId}\u0000${book.title}\u0000${book.author ?? ''}`),
  );
  return {
    kind: 'cover',
    binary,
    fileName: `${book.title.slice(0, 80) || 'cover'}-moya.png`,
    declaredContentType: 'image/png',
    derivationFingerprint,
    fit: 'contain',
    positionX: 50,
    positionY: 50,
    rationale: '작품 제목과 저자를 이용해 브라우저 안에서 만든 기본 표지입니다.',
    sourceLabel: '개발용 로컬 표지 샘플',
    licenseSummary: '외부 이미지를 사용하지 않은 로컬 생성 샘플',
    sourceFingerprints: [`book-metadata:${derivationFingerprint}`],
  };
}

export const libraryBookEnrichmentTrustedExtension: TrustedExtensionDefinition<
  TrustedReaderAddonHostContext,
  TrustedAnalysisWorkflowHostContext
> = {
  manifest,
  activate(context) {
    return context.bookEnrichmentProviders.register(LIBRARY_BOOK_ENRICHMENT_PROVIDER_ID, {
      async propose({ book, signal }) {
        if (signal?.aborted) throw new DOMException('Book enrichment was cancelled.', 'AbortError');
        const drafts: BookEnrichmentCandidateDraft[] = [];
        const metadata = proposedMetadata(book);
        if (metadata) drafts.push(metadata);
        const cover = await proposedCover(book);
        if (cover) drafts.push(cover);
        return drafts;
      },
    });
  },
};
