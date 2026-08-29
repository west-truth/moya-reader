import {
  MOYA_EXTENSION_API_VERSION,
  MOYA_EXTENSION_MANIFEST_VERSION,
  type ExtensionManifestV1,
} from '@noveldesk/extension-contracts';
import { integrityHash } from '../../domain/id-hash-contract';
import { extractWorkTitle } from '../../domain/work-title-extraction';
import type {
  BookEnrichmentCandidateDraft,
  BookEnrichmentMetadataValues,
  PublicBookMetadataSnapshot,
} from '../../features/book-enrichment/book-enrichment-contract';
import type {
  WebNovelMetadataCollectorCover,
  WebNovelMetadataCollectorResolveInput,
  WebNovelMetadataCollectorResolveResult,
} from '../../services/webnovel-metadata-collector-client';
import { webNovelMetadataCollectorAutomationEvidence } from '../../services/webnovel-metadata-collector-client';
import type { TrustedAnalysisWorkflowHostContext } from '../analysis-workflow-host-context';
import type { TrustedReaderAddonHostContext } from '../reader-addon-host-context';
import type { TrustedExtensionDefinition } from '../trusted-extension-registry';

export const WEBNOVEL_METADATA_ENRICHMENT_EXTENSION_ID = 'moya.library.webnovel-metadata' as const;
export const WEBNOVEL_METADATA_ENRICHMENT_PROVIDER_ID = 'moya.library.webnovel-metadata.lookup' as const;

export interface WebNovelMetadataEnrichmentCollectorPort {
  resolve(
    input: WebNovelMetadataCollectorResolveInput,
    signal?: AbortSignal,
  ): Promise<WebNovelMetadataCollectorResolveResult>;
  downloadCover(coverRef: string, signal?: AbortSignal): Promise<WebNovelMetadataCollectorCover>;
}

export interface WebNovelMetadataEnrichmentProposalIssue {
  readonly code: string;
  readonly message: string;
}

export interface WebNovelMetadataEnrichmentProposal {
  readonly resolution: WebNovelMetadataCollectorResolveResult;
  readonly drafts: readonly BookEnrichmentCandidateDraft[];
  readonly coverIssue?: WebNovelMetadataEnrichmentProposalIssue;
}

const manifest = {
  manifestVersion: MOYA_EXTENSION_MANIFEST_VERSION,
  id: WEBNOVEL_METADATA_ENRICHMENT_EXTENSION_ID,
  name: '웹소설 표지·작품 정보',
  version: '1.0.0',
  engine: { moyaApi: MOYA_EXTENSION_API_VERSION },
  permissions: ['book.enrichment.propose'],
  contributes: {
    bookEnrichmentProviders: [
      {
        id: WEBNOVEL_METADATA_ENRICHMENT_PROVIDER_ID,
        schemaVersion: 1,
        title: '웹소설 표지·작품 정보 찾기',
        description: '내장 수집기에서 작품을 찾아 메타데이터와 표지를 검토 후보로 만듭니다.',
        capabilities: ['metadata', 'cover'],
        order: 20,
      },
    ],
  },
} as const satisfies ExtensionManifestV1;

const PLATFORM_LABELS: Readonly<Record<string, string>> = {
  munpia: '문피아',
  naver_series: '네이버 시리즈',
  kakao_page: '카카오페이지',
  novelpia: '노벨피아',
  ridi: '리디',
};

const STATUS_TAGS: Readonly<Record<string, string>> = {
  ongoing: '연재중',
  completed: '완결',
  hiatus: '휴재',
};

function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform;
}

function proposalIssue(error: unknown): WebNovelMetadataEnrichmentProposalIssue {
  const code =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'cover_download_failed';
  return {
    code,
    message:
      error instanceof Error && error.message.trim()
        ? error.message
        : '추천 표지를 가져오지 못했지만 작품 정보 후보는 유지했습니다.',
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function sourceIdentity(result: WebNovelMetadataCollectorResolveResult): string {
  const metadata = result.metadata;
  if (!metadata) throw new Error('찾은 작품 정보가 비어 있습니다.');
  return `${metadata.platform}\u0000${metadata.platformWorkId}\u0000${metadata.sourceUrl}`;
}

function mergeTags(book: PublicBookMetadataSnapshot, result: WebNovelMetadataCollectorResolveResult): string[] {
  const metadata = result.metadata;
  if (!metadata) return [...book.tags];
  const candidates = [
    ...book.tags,
    ...metadata.genres,
    ...metadata.tags,
    ...(metadata.status && STATUS_TAGS[metadata.status] ? [STATUS_TAGS[metadata.status]!] : []),
  ];
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const value of candidates) {
    const tag = value.trim().replace(/\s+/gu, ' ');
    if (!tag || tag.length > 80) continue;
    const key = tag.toLocaleLowerCase('ko');
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length === 50) break;
  }
  return tags;
}

function rationale(result: WebNovelMetadataCollectorResolveResult): string {
  const metadata = result.metadata;
  if (!metadata) return '웹소설 정보 수집 결과입니다.';
  const match =
    result.matchType === 'exact_title_and_author'
      ? '제목과 작가가 정확히 일치'
      : result.matchType === 'exact_title'
        ? '제목이 정확히 일치'
        : result.matchType === 'fuzzy_title'
          ? '유사한 제목으로 일치'
          : '여러 후보 중 선택';
  const quality = result.metadataQuality === 'full' ? '상세 작품 정보' : '검색 결과의 일부 정보';
  return `${platformLabel(metadata.platform)}에서 ${match}한 ${quality}를 가져왔습니다.`;
}

function metadataDraft(
  book: PublicBookMetadataSnapshot,
  result: WebNovelMetadataCollectorResolveResult,
): BookEnrichmentCandidateDraft {
  const metadata = result.metadata;
  if (!metadata) throw new Error('찾은 작품 정보가 비어 있습니다.');
  const patch: BookEnrichmentMetadataValues = {
    title: metadata.title,
    ...(metadata.author ? { author: metadata.author } : undefined),
    tags: mergeTags(book, result),
    ...(metadata.description ? { description: metadata.description } : undefined),
  };
  const identityHash = integrityHash(sourceIdentity(result));
  return {
    kind: 'metadata',
    proposalGroupId: `webnovel:${identityHash}`,
    patch,
    confidence: result.confidence,
    rationale: rationale(result),
    sourceFingerprints: [`webnovel-work:${identityHash}`],
    providerId: 'webnovel-metadata-collector',
    sourceLabel: platformLabel(metadata.platform),
    sourceUrl: metadata.sourceUrl,
    automation: webNovelMetadataCollectorAutomationEvidence(result),
  };
}

function safeCoverFileName(title: string, contentType: WebNovelMetadataCollectorCover['contentType']): string {
  const extension = contentType === 'image/jpeg' ? 'jpg' : contentType === 'image/png' ? 'png' : 'webp';
  const printableTitle = [...title].map((character) => (character.charCodeAt(0) < 32 ? ' ' : character)).join('');
  const stem = printableTitle
    .replace(/[<>:"/\\|?*]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .replace(/[. ]+$/gu, '')
    .trim()
    .slice(0, 80);
  return `${stem || 'webnovel-cover'}.${extension}`;
}

async function coverDraft(
  result: WebNovelMetadataCollectorResolveResult,
  cover: WebNovelMetadataCollectorCover,
): Promise<BookEnrichmentCandidateDraft> {
  const metadata = result.metadata;
  if (!metadata) throw new Error('찾은 작품 정보가 비어 있습니다.');
  const identityHash = integrityHash(sourceIdentity(result));
  const coverContentHash = integrityHash(await cover.blob.arrayBuffer());
  const derivationFingerprint = integrityHash(`${identityHash}\u0000${coverContentHash}`);
  return {
    kind: 'cover',
    proposalGroupId: `webnovel:${identityHash}`,
    binary: cover.blob,
    fileName: safeCoverFileName(metadata.title, cover.contentType),
    declaredContentType: cover.contentType,
    derivationFingerprint,
    fit: 'contain',
    positionX: 50,
    positionY: 50,
    confidence: result.confidence,
    rationale: `${platformLabel(metadata.platform)} 작품 페이지에서 제공한 표지입니다.`,
    sourceFingerprints: [`webnovel-work:${identityHash}`, `cover-content:${coverContentHash}`],
    providerId: 'webnovel-metadata-collector',
    sourceLabel: platformLabel(metadata.platform),
    sourceUrl: metadata.sourceUrl,
    licenseSummary:
      '원본 플랫폼이 제공한 표지입니다. 개인 서재 표시용 후보로 가져왔으며 재배포·상업적 이용 권한은 확인되지 않았습니다.',
    automation: webNovelMetadataCollectorAutomationEvidence(result),
  };
}

function resolutionError(result: WebNovelMetadataCollectorResolveResult): Error | undefined {
  if (result.status === 'ambiguous') {
    return new Error('동일하거나 비슷한 작품 후보가 여러 개라 자동으로 고르지 않았습니다. 작가명을 확인해 주세요.');
  }
  if (result.status === 'failed') {
    const platforms = result.failedPlatforms.map(platformLabel).join(', ');
    return new Error(
      platforms
        ? `작품 정보를 찾는 중 플랫폼 연결에 실패했습니다. (${platforms})`
        : '작품 정보를 찾는 중 수집기 요청이 실패했습니다.',
    );
  }
  return undefined;
}

export async function createWebNovelMetadataEnrichmentProposal(
  collector: WebNovelMetadataEnrichmentCollectorPort,
  book: PublicBookMetadataSnapshot,
  signal?: AbortSignal,
): Promise<WebNovelMetadataEnrichmentProposal> {
  const title = extractWorkTitle(book.title, book.sourceFileName);
  let resolution: WebNovelMetadataCollectorResolveResult | undefined;
  for (const query of title.queryCandidates) {
    signal?.throwIfAborted();
    resolution = await collector.resolve({ query, author: book.author }, signal);
    if (resolution.status !== 'not_found') break;
  }
  if (!resolution) throw new Error('검색할 작품 제목이 비어 있습니다.');
  const failure = resolutionError(resolution);
  if (failure) throw failure;
  if (resolution.status !== 'found' || !resolution.metadata) return { resolution, drafts: [] };

  const drafts: BookEnrichmentCandidateDraft[] = [metadataDraft(book, resolution)];
  let coverIssue: WebNovelMetadataEnrichmentProposalIssue | undefined;
  if (resolution.coverRef) {
    try {
      drafts.push(await coverDraft(resolution, await collector.downloadCover(resolution.coverRef, signal)));
    } catch (error) {
      if (isAbortError(error)) throw error;
      coverIssue = proposalIssue(error);
      const metadata = drafts[0];
      if (metadata?.kind === 'metadata') {
        drafts[0] = {
          ...metadata,
          rationale: `${metadata.rationale ?? '웹소설 작품 정보를 찾았습니다.'} ${coverIssue.message}`,
        };
      }
    }
  }
  return { resolution, drafts, coverIssue };
}

export function createWebNovelMetadataEnrichmentTrustedExtension(
  collector: WebNovelMetadataEnrichmentCollectorPort,
): TrustedExtensionDefinition<TrustedReaderAddonHostContext, TrustedAnalysisWorkflowHostContext> {
  return {
    manifest,
    activate(context) {
      return context.bookEnrichmentProviders.register(WEBNOVEL_METADATA_ENRICHMENT_PROVIDER_ID, {
        async propose({ book, signal }) {
          const proposal = await createWebNovelMetadataEnrichmentProposal(collector, book, signal);
          return proposal.drafts;
        },
      });
    },
  };
}
