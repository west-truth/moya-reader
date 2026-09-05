import {
  buildDocumentSeriesArchive,
  documentSeriesConfigurationFingerprint,
  inspectDocumentSeriesSource,
  readDocumentSeriesArchive,
  REMOTE_DOCUMENT_IDENTITY_SCHEME,
  REMOTE_DOCUMENT_LIMITS,
  type DocumentSeriesCollection,
  type DocumentSeriesSourceInput,
} from '@noveldesk/document-series-core';
import { integrityHash } from '@noveldesk/text-core/hash';
import type { ImportExpectedBase } from '../../services/import/import-service';
import type { ExternalItemSummary, ExternalSourceCollectionDescriptorV2, ExternalSourceContent } from '../contracts';
import { externalDocumentCollectionId, externalDocumentReleaseSourceId } from './document-series-identity';

export interface ExternalDocumentSeriesReleaseInput {
  readonly item: ExternalItemSummary;
  readonly content: ExternalSourceContent;
  readonly sourceContentHash: string;
  readonly remoteRevision?: string;
  /** null fences a release that was absent in the original assembly snapshot. */
  readonly expectedPreviousSourceContentHash?: string | null;
}

export interface AssembleDocumentSeriesInput {
  readonly collection: ExternalSourceCollectionDescriptorV2;
  readonly releases: readonly ExternalDocumentSeriesReleaseInput[];
  readonly targetBookId: string;
  readonly existingSource?: { readonly blob: Blob; readonly contentType?: string };
  readonly expectedBase: ImportExpectedBase;
  readonly signal: AbortSignal;
}

export interface DocumentSeriesAssemblyResult {
  readonly file?: File;
  readonly expectedBase: ImportExpectedBase;
  readonly configurationFingerprint: string;
  readonly change: 'content' | 'configuration' | 'none';
  readonly releaseProjections: readonly {
    readonly remoteId: string;
    readonly sourceId: string;
    readonly sourceContentHash: string;
    readonly previousSourceContentHash: string | null;
  }[];
}

function normalizedHash(value: string): string {
  return value.replace(/^sha256:/iu, '').toLocaleLowerCase();
}

/** Assemble only a caller-selected, bounded release batch. Activation and link ownership remain in the coordinator. */
export async function assembleDocumentSeries(
  input: AssembleDocumentSeriesInput,
): Promise<DocumentSeriesAssemblyResult> {
  input.signal.throwIfAborted();
  const profile = input.collection.seriesProfile;
  if (
    profile.kind !== 'document_series' ||
    profile.format !== 'txt' ||
    profile.encoding !== 'utf-8' ||
    profile.chapterSplitMode !== 'single'
  ) {
    throw new Error('외부 문서 연재는 UTF-8 TXT 단일 회차만 지원합니다.');
  }
  const first = input.releases[0];
  if (!first || !input.targetBookId.trim()) throw new Error('가져올 회차와 대상 작품이 필요합니다.');
  if ((input.expectedBase.kind === 'revision') !== Boolean(input.existingSource))
    throw new Error('기존 작품 원본과 기준 revision이 일치하지 않습니다.');
  const collectionId = externalDocumentCollectionId(first.item.key, input.collection.remoteId);
  const existing = input.existingSource ? await readDocumentSeriesArchive(input.existingSource.blob) : undefined;
  input.signal.throwIfAborted();
  if (
    input.existingSource &&
    (!existing || existing.manifest.schemaVersion !== 2 || existing.manifest.collection.id !== collectionId)
  ) {
    throw new Error('이 원본은 같은 외부 TXT 연재 작품이 아니므로 자동 병합하지 않습니다.');
  }
  const sources = new Map<string, DocumentSeriesSourceInput>();
  for (const descriptor of existing?.manifest.sources ?? []) {
    const blob = existing!.sources.get(descriptor.id)!;
    const { entryName: _entryName, byteLength: _byteLength, ...source } = descriptor;
    sources.set(source.id, { ...source, blob });
  }
  const selectedIds = new Set<string>();
  const releaseProjections: DocumentSeriesAssemblyResult['releaseProjections'][number][] = [];
  let contentChanged = !existing;
  let totalBytes = [...sources.values()].reduce((sum, source) => sum + source.blob.size, 0);
  for (const release of input.releases) {
    input.signal.throwIfAborted();
    const { item, content } = release;
    if (
      !item.release ||
      item.collection?.remoteId !== input.collection.remoteId ||
      externalDocumentCollectionId(item.key, input.collection.remoteId) !== collectionId ||
      item.collection.seriesProfile?.kind !== 'document_series' ||
      content.kind !== 'document' ||
      content.format !== 'txt' ||
      content.encoding !== 'utf-8' ||
      content.chapterSplitMode !== 'single'
    ) {
      throw new Error('회차의 연결, 작품 또는 문서 형식이 가져오기 계획과 다릅니다.');
    }
    const sourceId = externalDocumentReleaseSourceId(item.key, input.collection.remoteId);
    if (selectedIds.has(sourceId)) throw new Error('같은 회차가 가져오기 묶음에 중복되었습니다.');
    selectedIds.add(sourceId);
    const previous = sources.get(sourceId);
    if (
      release.expectedPreviousSourceContentHash === null
        ? Boolean(previous)
        : release.expectedPreviousSourceContentHash !== undefined &&
          (!previous ||
            normalizedHash(previous.contentHash) !== normalizedHash(release.expectedPreviousSourceContentHash))
    ) {
      throw new Error('회차의 기존 본문이 변경되었습니다. 최신 작품을 다시 확인해 주세요.');
    }
    if (content.file.size <= 0 || content.file.size > REMOTE_DOCUMENT_LIMITS.sourceBytes)
      throw new Error('외부 TXT 회차 원문은 2 MiB 이하여야 합니다.');
    totalBytes += content.file.size - (previous?.blob.size ?? 0);
    if (
      totalBytes > REMOTE_DOCUMENT_LIMITS.totalBytes ||
      sources.size + (previous ? 0 : 1) > REMOTE_DOCUMENT_LIMITS.sourceCount
    ) {
      throw new Error('외부 TXT 작품은 1,000회차, 원문 합계 64 MiB 한도 안에서 가져올 수 있습니다.');
    }
    const bytes = new Uint8Array(await content.file.arrayBuffer());
    input.signal.throwIfAborted();
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const contentHash = integrityHash(bytes);
    if (normalizedHash(contentHash) !== normalizedHash(release.sourceContentHash))
      throw new Error('회차 원문 해시가 가져오기 계획과 다릅니다.');
    if (!previous || previous.contentHash !== contentHash) {
      const preview = await inspectDocumentSeriesSource({
        fileName: content.file.name,
        blob: content.file,
        format: 'txt',
        encoding: 'utf-8',
        chapterSplitMode: 'single',
      });
      input.signal.throwIfAborted();
      if (preview.chapters.length !== 1 || preview.chapters[0]?.index !== 1)
        throw new Error('회차에 읽을 수 있는 단일 본문이 없습니다.');
      contentChanged = true;
    }
    sources.set(sourceId, {
      id: sourceId,
      title: item.release.title,
      fileName: content.file.name,
      contentType: 'text/plain;charset=utf-8',
      contentHash,
      sourceOrder: item.release.sourceOrder ?? item.release.chapterNumber ?? 0,
      format: 'txt',
      encoding: 'utf-8',
      chapterSplitMode: 'single',
      includedChapterIndices: [1],
      extractionVersion: 'utf8-txt-v1',
      blob: previous?.contentHash === contentHash ? previous.blob : content.file,
    });
    releaseProjections.push({
      remoteId: item.key.remoteId,
      sourceId,
      sourceContentHash: contentHash,
      previousSourceContentHash: previous?.contentHash ?? null,
    });
  }
  const collection: DocumentSeriesCollection = {
    ...(existing?.manifest.collection ?? {}),
    id: collectionId,
    title: input.collection.title,
    format: 'txt',
    author: input.collection.author,
    description: input.collection.description,
    tags: input.collection.tags,
  };
  const assembly = {
    collection,
    sources: [...sources.values()],
    identityScheme: REMOTE_DOCUMENT_IDENTITY_SCHEME,
    signal: input.signal,
  };
  const configurationFingerprint = documentSeriesConfigurationFingerprint(assembly);
  const configurationChanged = existing?.manifest.configurationFingerprint !== configurationFingerprint;
  if (!contentChanged && !configurationChanged)
    return { expectedBase: input.expectedBase, configurationFingerprint, change: 'none', releaseProjections };
  input.signal.throwIfAborted();
  const file = await buildDocumentSeriesArchive(assembly);
  input.signal.throwIfAborted();
  return {
    file,
    expectedBase: input.expectedBase,
    configurationFingerprint,
    change: contentChanged ? 'content' : 'configuration',
    releaseProjections,
  };
}
