import type {
  DocumentSeriesArchiveContents,
  DocumentSeriesFormat,
  DocumentSeriesSourceInput,
  DocumentSeriesSourcePreview,
} from '@noveldesk/document-series-core';
import type { Chapter, ChapterSplitMode, EncodingMode, Novel } from '../../domain/types';
import { integrityHash, isIntegrityHash, tagLegacySha256Hash } from '@noveldesk/text-core/hash';
import { stableId } from '../../domain/hash';
import {
  normalizeSerialWorkKey,
  parseSerialReleaseName,
  type SerialReleaseName,
} from '../../domain/serial-release-name';
import type { BookAssetRepository, ExportedBookSource } from '../../repositories/book-asset-repository';
import { expandDocumentBundleFiles } from './document-bundle-archive';

export type LocalDocumentChapterDisposition = 'add' | 'duplicate' | 'conflict';

export interface LocalDocumentSourceCandidate {
  readonly id: string;
  readonly file: File;
  readonly contentHash: string;
  readonly parsedName: SerialReleaseName;
  readonly sourceTitle: string;
  readonly sourceOrder: number;
  readonly chapterSplitMode?: ChapterSplitMode;
  readonly preview: DocumentSeriesSourcePreview;
}

export interface LocalDocumentChapterCandidate {
  readonly id: string;
  readonly sourceId: string;
  readonly sourceTitle: string;
  readonly sourceFileName: string;
  readonly sourceChapterIndex: number;
  readonly title: string;
  readonly textHash: string;
  readonly characterCount: number;
  readonly paragraphCount: number;
}

export interface LocalDocumentSeriesInspection {
  readonly workTitle: string;
  readonly normalizedWorkKey: string;
  readonly format: DocumentSeriesFormat;
  readonly sources: readonly LocalDocumentSourceCandidate[];
  readonly chapters: readonly LocalDocumentChapterCandidate[];
  readonly candidateNovels: readonly Novel[];
}

export interface LocalDocumentPlannedChapter extends LocalDocumentChapterCandidate {
  readonly disposition: LocalDocumentChapterDisposition;
  readonly existingTitle?: string;
}

export interface LocalDocumentSeriesPlan {
  readonly inspection: LocalDocumentSeriesInspection;
  readonly targetNovel?: Novel;
  readonly targetSource?: ExportedBookSource;
  readonly targetChapters: readonly Chapter[];
  readonly existingArchive?: DocumentSeriesArchiveContents;
  readonly chapters: readonly LocalDocumentPlannedChapter[];
  readonly addCount: number;
  readonly duplicateCount: number;
  readonly conflictCount: number;
  readonly legacyChapterSplitMode?: ChapterSplitMode;
}

function documentFormat(fileName: string): DocumentSeriesFormat | undefined {
  if (/\.epub$/iu.test(fileName)) return 'epub';
  if (/\.(?:md|markdown)$/iu.test(fileName)) return 'markdown';
  if (/\.txt$/iu.test(fileName)) return 'txt';
  return undefined;
}

function documentReleaseName(fileName: string): string {
  return fileName.replace(/\.(?:txt|md|markdown|epub)$/iu, '');
}

function compatibleFamily(left: DocumentSeriesFormat, right: DocumentSeriesFormat): boolean {
  return left === 'epub' ? right === 'epub' : right === 'txt' || right === 'markdown';
}

function compatibleNovel(novel: Novel, format: DocumentSeriesFormat): boolean {
  return novel.format === 'epub'
    ? format === 'epub'
    : format !== 'epub' && (novel.format === 'txt' || novel.format === 'markdown');
}

function canonicalContentHash(value: string): string {
  const canonical = tagLegacySha256Hash(value.toLocaleLowerCase());
  if (!isIntegrityHash(canonical)) throw new Error('기존 작품 원본의 해시 형식을 확인하지 못했습니다.');
  return canonical;
}

function chapterTitleKey(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, '')
    .trim();
}

function releaseOrder(parsed: SerialReleaseName, fallbackIndex: number): number {
  if (parsed.seasonNumber !== undefined) {
    return parsed.seasonNumber * 1_000_000_000 + (parsed.volumeNumber ?? 0) * 1_000_000 + (parsed.chapterNumber ?? 0);
  }
  if (parsed.volumeNumber !== undefined) return parsed.volumeNumber * 1_000_000 + (parsed.chapterNumber ?? 0);
  if (parsed.chapterNumber !== undefined) return parsed.chapterNumber;
  return 1_000_000_000_000 + fallbackIndex;
}

function mostCommonWorkTitle(values: readonly SerialReleaseName[]): string | undefined {
  const counts = new Map<string, { title: string; count: number }>();
  for (const value of values) {
    if (!value.workTitle || !value.releaseKey || value.confidence === 'low') continue;
    const key = normalizeSerialWorkKey(value.workTitle);
    const current = counts.get(key);
    counts.set(key, { title: value.workTitle, count: (current?.count ?? 0) + 1 });
  }
  return [...counts.values()].sort((left, right) => right.count - left.count)[0]?.title;
}

function sourceChapterTitle(source: LocalDocumentSourceCandidate, index: number): string {
  const chapter = source.preview.chapters[index]!;
  return source.preview.chapters.length === 1 ? source.sourceTitle : chapter.title;
}

function candidateNovels(novels: readonly Novel[], workTitle: string, format: DocumentSeriesFormat): Novel[] {
  const key = normalizeSerialWorkKey(workTitle);
  return novels.filter(
    (novel) =>
      compatibleNovel(novel, format) &&
      [novel.title, novel.seriesTitle]
        .filter((value): value is string => Boolean(value))
        .some((value) => normalizeSerialWorkKey(value) === key),
  );
}

export async function inspectLocalDocumentSeriesImport(
  files: readonly File[],
  novels: readonly Novel[],
  options: {
    readonly targetNovel?: Novel;
    readonly encoding: EncodingMode;
    readonly chapterSplitMode: ChapterSplitMode;
    readonly password?: string;
  },
): Promise<LocalDocumentSeriesInspection | undefined> {
  const expanded = await expandDocumentBundleFiles(files, options.password);
  if (!expanded) return undefined;
  const documentFiles = expanded.files;
  if (documentFiles.length === 1 && !expanded.fromArchive && !options.targetNovel) return undefined;
  const formats = documentFiles.map((file) => documentFormat(file.name));
  const format = formats[0];
  if (!format || formats.some((candidate) => !candidate || !compatibleFamily(format, candidate))) {
    throw new Error('EPUB과 TXT/Markdown은 서로 분리해서 회차를 추가해 주세요.');
  }
  if (options.targetNovel && !compatibleNovel(options.targetNovel, format)) {
    throw new Error('기존 작품과 같은 문서 형식의 파일만 회차로 추가할 수 있습니다.');
  }

  const titleHint = options.targetNovel?.title ?? expanded.archiveWorkTitle;
  const firstNames = documentFiles.map((file) => parseSerialReleaseName(documentReleaseName(file.name), titleHint));
  const commonTitle = options.targetNovel?.title ?? mostCommonWorkTitle(firstNames) ?? expanded.archiveWorkTitle;
  if (!commonTitle) return undefined;
  const { inspectDocumentSeriesSource } = await import('@noveldesk/document-series-core');
  const sources: LocalDocumentSourceCandidate[] = [];
  for (const [index, file] of documentFiles.entries()) {
    const parsedName = parseSerialReleaseName(documentReleaseName(file.name), commonTitle);
    if (
      !options.targetNovel &&
      parsedName.workTitle &&
      parsedName.releaseKey &&
      normalizeSerialWorkKey(parsedName.workTitle) !== normalizeSerialWorkKey(commonTitle)
    ) {
      return undefined;
    }
    const contentHash = integrityHash(new Uint8Array(await file.arrayBuffer()));
    const preview = await inspectDocumentSeriesSource({
      fileName: file.name,
      blob: file,
      format: formats[index],
      encoding: options.encoding,
      chapterSplitMode: options.chapterSplitMode,
    });
    const sourceTitle = parsedName.releaseKey ? parsedName.releaseTitle : preview.title;
    sources.push({
      id: stableId('local_document_source', `${contentHash}:${file.name.normalize('NFKC')}`, 20),
      file,
      contentHash,
      parsedName,
      sourceTitle,
      sourceOrder: releaseOrder(parsedName, index + 1),
      chapterSplitMode: preview.format === 'epub' ? undefined : options.chapterSplitMode,
      preview,
    });
  }
  const chapters = sources.flatMap((source) =>
    source.preview.chapters.map((chapter, index) => ({
      id: stableId('local_document_chapter', `${source.id}:${chapter.index}:${chapter.textHash}`, 20),
      sourceId: source.id,
      sourceTitle: source.sourceTitle,
      sourceFileName: source.file.name,
      sourceChapterIndex: chapter.index,
      title: sourceChapterTitle(source, index),
      textHash: chapter.textHash,
      characterCount: chapter.characterCount,
      paragraphCount: chapter.paragraphCount,
    })),
  );
  return {
    workTitle: commonTitle,
    normalizedWorkKey: normalizeSerialWorkKey(commonTitle),
    format,
    sources,
    chapters,
    candidateNovels: options.targetNovel ? [options.targetNovel] : candidateNovels(novels, commonTitle, format),
  };
}

async function resolveLegacySplitMode(
  novel: Novel,
  source: ExportedBookSource,
  chapters: readonly Chapter[],
): Promise<ChapterSplitMode | undefined> {
  if (novel.format === 'epub') return undefined;
  const { inspectDocumentSeriesSource } = await import('@noveldesk/document-series-core');
  const fileName = source.metadata.fileName ?? novel.sourceFileName;
  for (const mode of ['auto', 'mixed', 'single'] as const) {
    const preview = await inspectDocumentSeriesSource({
      fileName,
      blob: source.blob,
      format: novel.format === 'markdown' ? 'markdown' : 'txt',
      encoding: novel.sourceEncoding,
      chapterSplitMode: mode,
    });
    if (
      preview.chapters.length === chapters.length &&
      preview.chapters.every((chapter, index) => chapter.textHash === chapters[index]?.textHash)
    ) {
      return mode;
    }
  }
  throw new Error('기존 작품의 회차 분리 방식을 원본에서 안전하게 재현할 수 없어 자동 병합하지 않았습니다.');
}

export async function planLocalDocumentSeriesImport(
  inspection: LocalDocumentSeriesInspection,
  targetNovel: Novel | undefined,
  targetChapters: readonly Chapter[],
  assets: BookAssetRepository | undefined,
): Promise<LocalDocumentSeriesPlan> {
  const targetSource = targetNovel ? await assets?.exportSource(targetNovel.id) : undefined;
  if (targetNovel && !targetSource) throw new Error('기존 작품의 원본을 찾지 못해 회차를 안전하게 추가할 수 없습니다.');
  const existingArchive = targetSource
    ? await import('@noveldesk/document-series-core').then(({ readDocumentSeriesArchive }) =>
        readDocumentSeriesArchive(targetSource.blob),
      )
    : undefined;
  const legacyChapterSplitMode =
    targetNovel && targetSource && !existingArchive
      ? await resolveLegacySplitMode(targetNovel, targetSource, targetChapters)
      : undefined;

  const identities = new Set(
    targetChapters.map((chapter) => `${chapterTitleKey(chapter.title)}:${chapter.textHash.toLocaleLowerCase()}`),
  );
  const titles = new Map(targetChapters.map((chapter) => [chapterTitleKey(chapter.title), chapter.title]));
  const chapters: LocalDocumentPlannedChapter[] = [];
  for (const chapter of inspection.chapters) {
    const hash = chapter.textHash.toLocaleLowerCase();
    const titleKey = chapterTitleKey(chapter.title);
    const titleMatch = titles.get(titleKey);
    let disposition: LocalDocumentChapterDisposition = 'add';
    let existingTitle: string | undefined;
    if (identities.has(`${titleKey}:${hash}`)) {
      disposition = 'duplicate';
      existingTitle = titleMatch;
    } else if (titleMatch) {
      disposition = 'conflict';
      existingTitle = titleMatch;
    }
    chapters.push({ ...chapter, disposition, existingTitle });
    if (disposition === 'add') {
      identities.add(`${titleKey}:${hash}`);
      titles.set(titleKey, chapter.title);
    }
  }
  return {
    inspection,
    targetNovel,
    targetSource,
    targetChapters,
    existingArchive,
    chapters,
    addCount: chapters.filter((chapter) => chapter.disposition === 'add').length,
    duplicateCount: chapters.filter((chapter) => chapter.disposition === 'duplicate').length,
    conflictCount: chapters.filter((chapter) => chapter.disposition === 'conflict').length,
    legacyChapterSplitMode,
  };
}

function sourceInputFromExisting(
  descriptor: DocumentSeriesArchiveContents['manifest']['sources'][number],
  blob: Blob,
): DocumentSeriesSourceInput {
  const { entryName: _entryName, byteLength: _byteLength, ...source } = descriptor;
  return { ...source, blob };
}

export async function buildLocalDocumentSeriesImportFile(
  plan: LocalDocumentSeriesPlan,
  signal: AbortSignal,
): Promise<File | undefined> {
  if (!plan.addCount) return undefined;
  const { buildDocumentSeriesArchive } = await import('@noveldesk/document-series-core');
  const sources: DocumentSeriesSourceInput[] = [];
  if (plan.existingArchive) {
    for (const descriptor of plan.existingArchive.manifest.sources) {
      const blob = plan.existingArchive.sources.get(descriptor.id);
      if (!blob) throw new Error(`${descriptor.fileName} 기존 원본을 찾지 못했습니다.`);
      sources.push(sourceInputFromExisting(descriptor, blob));
    }
  } else if (plan.targetNovel && plan.targetSource) {
    const format =
      plan.targetNovel.format === 'epub' ? 'epub' : plan.targetNovel.format === 'markdown' ? 'markdown' : 'txt';
    const fileName = plan.targetSource.metadata.fileName ?? plan.targetNovel.sourceFileName;
    const parsed = parseSerialReleaseName(documentReleaseName(fileName), plan.targetNovel.title);
    sources.push({
      id: stableId('local_document_source', plan.targetSource.metadata.contentHash, 20),
      title:
        plan.targetChapters.length === 1
          ? plan.targetChapters[0]!.title
          : parsed.releaseKey
            ? parsed.releaseTitle
            : plan.targetNovel.title,
      fileName,
      contentType: plan.targetSource.metadata.contentType,
      contentHash: canonicalContentHash(plan.targetSource.metadata.contentHash),
      sourceOrder: releaseOrder(parsed, 0),
      format,
      encoding: plan.targetNovel.sourceEncoding,
      chapterSplitMode: plan.legacyChapterSplitMode,
      includedChapterIndices: plan.targetChapters.map((chapter) => chapter.index),
      chapterTitles: Object.fromEntries(plan.targetChapters.map((chapter) => [String(chapter.index), chapter.title])),
      blob: plan.targetSource.blob,
    });
  }

  for (const source of plan.inspection.sources) {
    const includedChapterIndices = plan.chapters
      .filter((chapter) => chapter.sourceId === source.id && chapter.disposition === 'add')
      .map((chapter) => chapter.sourceChapterIndex);
    if (!includedChapterIndices.length) continue;
    sources.push({
      id: source.id,
      title: source.sourceTitle,
      fileName: source.file.name,
      contentType: source.file.type || (source.preview.format === 'epub' ? 'application/epub+zip' : 'text/plain'),
      contentHash: source.contentHash,
      sourceOrder: source.sourceOrder,
      format: source.preview.format,
      encoding: source.preview.encoding,
      chapterSplitMode: source.chapterSplitMode,
      includedChapterIndices,
      chapterTitles: Object.fromEntries(
        plan.chapters
          .filter((chapter) => chapter.sourceId === source.id && chapter.disposition === 'add')
          .map((chapter) => [String(chapter.sourceChapterIndex), chapter.title]),
      ),
      blob: source.file,
    });
  }
  const target = plan.targetNovel;
  return buildDocumentSeriesArchive({
    collection: {
      id:
        plan.existingArchive?.manifest.collection.id ??
        stableId('local_document_series', plan.inspection.normalizedWorkKey, 20),
      title: target?.title ?? plan.inspection.workTitle,
      format: target?.format === 'epub' ? 'epub' : target?.format === 'markdown' ? 'markdown' : plan.inspection.format,
      author: target?.author ?? plan.inspection.sources[0]?.preview.author,
      seriesTitle: target?.seriesTitle,
      seriesIndex: target?.seriesIndex,
      description: target?.description ?? plan.inspection.sources[0]?.preview.description,
      language: target?.language ?? plan.inspection.sources[0]?.preview.language,
      readingDirection: target?.readingDirection,
      tags: target?.tags,
      metadataRevision: target?.metadataRevision,
    },
    sources,
    signal,
  });
}
