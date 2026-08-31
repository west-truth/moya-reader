import { BlobReader, BlobWriter, ZipReader, type FileEntry } from '@zip.js/zip.js';
import type { Chapter, Novel } from '../../domain/types';
import { sha256, stableId } from '../../domain/hash';
import {
  normalizeSerialWorkKey,
  parseSerialReleaseName,
  type SerialReleaseName,
} from '../../domain/serial-release-name';
import type { BookAssetRepository, ExportedBookSource } from '../../repositories/book-asset-repository';
import {
  buildSeriesImageArchive,
  readSeriesImageArchiveManifest,
  type SeriesImageArchiveManifest,
  type SeriesImageChapterInput,
} from '../../services/import/series-image-archive';

const ARCHIVE_FILE = /\.(?:zip|cbz|rar|cbr|7z|cb7)$/iu;
const NESTABLE_ARCHIVE_FILE = /\.(?:zip|cbz)$/iu;
const IMAGE_FILE = /\.(?:jpe?g|png|webp|gif)$/iu;
const MAX_CHILD_ARCHIVES = 500;
const MAX_CHILD_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_CHILD_BYTES = 1024 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 250;

export type LocalSeriesSourceKind = 'nested_package' | 'selected_archives';
export type LocalSeriesReleaseDisposition = 'add' | 'duplicate' | 'conflict';

export interface LocalSeriesReleaseCandidate {
  readonly id: string;
  readonly file: File;
  readonly originalName: string;
  readonly parsed: SerialReleaseName;
  readonly releaseKey: string;
  readonly contentHash: string;
  readonly pageCount: number;
}

export interface LocalSeriesImportInspection {
  readonly sourceKind: LocalSeriesSourceKind;
  readonly workTitle: string;
  readonly normalizedWorkKey: string;
  readonly confidence: SerialReleaseName['confidence'];
  readonly releases: readonly LocalSeriesReleaseCandidate[];
  readonly candidateNovels: readonly Novel[];
  readonly sourceFileNames: readonly string[];
}

export interface LocalSeriesPlannedRelease extends LocalSeriesReleaseCandidate {
  readonly disposition: LocalSeriesReleaseDisposition;
  readonly existingTitle?: string;
}

export interface LocalSeriesImportPlan {
  readonly inspection: LocalSeriesImportInspection;
  readonly targetNovel?: Novel;
  readonly targetSource?: ExportedBookSource;
  readonly existingManifest?: SeriesImageArchiveManifest;
  /**
   * The selected releases are a self-contained delta for a canonical local
   * image series. The import boundary owns merging it with the active source.
   */
  readonly incrementalAppend?: boolean;
  readonly releases: readonly LocalSeriesPlannedRelease[];
  readonly addCount: number;
  readonly duplicateCount: number;
  readonly conflictCount: number;
}

export interface PlanLocalSeriesImportOptions {
  readonly incrementalAppend?: boolean;
  readonly existingChapters?: readonly Chapter[];
}

function isArchiveFile(file: File): boolean {
  return ARCHIVE_FILE.test(file.name);
}

function normalizedArchivePath(value: string): string {
  const clean = value.replace(/\\/gu, '/').normalize('NFKC').trim();
  if (!clean || clean.startsWith('/') || /^[a-z][a-z0-9+.-]*:/iu.test(clean)) {
    throw new Error('바깥 압축 파일에 허용되지 않는 절대 경로가 있습니다.');
  }
  const parts: string[] = [];
  for (const part of clean.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') throw new Error('바깥 압축 파일의 항목이 압축 파일 밖을 가리킵니다.');
    parts.push(part);
  }
  if (!parts.length) throw new Error('바깥 압축 파일에 빈 항목 경로가 있습니다.');
  return parts.join('/');
}

async function childArchiveFiles(file: File, password?: string): Promise<File[] | undefined> {
  if (!NESTABLE_ARCHIVE_FILE.test(file.name)) return undefined;
  const reader = new ZipReader(new BlobReader(file), { password });
  try {
    const entries = await reader.getEntries();
    const directImages = entries.filter((entry) => !entry.directory && IMAGE_FILE.test(entry.filename));
    const children = entries.filter(
      (entry): entry is FileEntry =>
        !entry.directory && NESTABLE_ARCHIVE_FILE.test(entry.filename) && Boolean((entry as FileEntry).getData),
    );
    if (!children.length) return undefined;
    if (directImages.length) {
      throw new Error('이미지와 회차별 압축파일이 함께 들어 있는 혼합 패키지는 자동 판정할 수 없습니다.');
    }
    if (children.length > MAX_CHILD_ARCHIVES) throw new Error('바깥 압축 파일의 회차 수가 안전 한도를 초과했습니다.');
    let totalBytes = 0;
    const files: File[] = [];
    for (const entry of children.sort((left, right) =>
      left.filename.localeCompare(right.filename, 'ko', { numeric: true }),
    )) {
      const path = normalizedArchivePath(entry.filename);
      const size = Number(entry.uncompressedSize ?? 0);
      const compressed = Math.max(1, Number(entry.compressedSize ?? size));
      if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_CHILD_ARCHIVE_BYTES) {
        throw new Error(`${path} 회차 압축파일의 크기가 안전 한도를 벗어났습니다.`);
      }
      if (size > compressed * MAX_COMPRESSION_RATIO) {
        throw new Error(`${path} 회차 압축파일의 압축률이 안전 한도를 초과했습니다.`);
      }
      totalBytes += size;
      if (totalBytes > MAX_TOTAL_CHILD_BYTES) throw new Error('회차 압축파일의 전체 크기가 안전 한도를 초과했습니다.');
      if (entry.encrypted && !password) throw new Error('바깥 압축 파일에 암호가 필요합니다.');
      const blob = await entry.getData!(new BlobWriter('application/vnd.comicbook+zip'));
      const nestedReader = new ZipReader(new BlobReader(blob), { password });
      try {
        const nestedEntries = await nestedReader.getEntries();
        if (nestedEntries.some((candidate) => !candidate.directory && NESTABLE_ARCHIVE_FILE.test(candidate.filename))) {
          throw new Error(`${path} 안에 또 다른 압축파일이 있습니다. 중첩 압축은 한 단계까지만 지원합니다.`);
        }
      } finally {
        await nestedReader.close().catch(() => undefined);
      }
      files.push(
        new File([blob], path.split('/').at(-1) ?? path, {
          type: 'application/vnd.comicbook+zip',
          lastModified: file.lastModified,
        }),
      );
    }
    return files;
  } finally {
    await reader.close().catch(() => undefined);
  }
}

function mostCommonExplicitTitle(parsed: readonly SerialReleaseName[]): string | undefined {
  const counts = new Map<string, { title: string; count: number }>();
  for (const candidate of parsed) {
    if (!candidate.workTitle || !candidate.releaseKey || candidate.confidence === 'low') continue;
    const key = normalizeSerialWorkKey(candidate.workTitle);
    const current = counts.get(key);
    counts.set(key, { title: candidate.workTitle, count: (current?.count ?? 0) + 1 });
  }
  return [...counts.values()].sort((left, right) => right.count - left.count)[0]?.title;
}

function candidateNovelsForTitle(novels: readonly Novel[], workTitle: string): Novel[] {
  const key = normalizeSerialWorkKey(workTitle);
  return novels.filter(
    (novel) =>
      novel.format === 'image_archive' &&
      [novel.title, novel.seriesTitle]
        .filter((value): value is string => Boolean(value))
        .some((value) => normalizeSerialWorkKey(value) === key),
  );
}

function unknownReleaseKey(parsed: SerialReleaseName): string {
  return `title:${normalizeSerialWorkKey(parsed.releaseTitle)}`;
}

function releaseSourceOrder(parsed: SerialReleaseName, fallbackIndex: number): number {
  if (parsed.seasonNumber !== undefined) {
    return parsed.seasonNumber * 1_000_000_000 + (parsed.volumeNumber ?? 0) * 1_000_000 + (parsed.chapterNumber ?? 0);
  }
  if (parsed.volumeNumber !== undefined) {
    return parsed.volumeNumber * 1_000_000 + (parsed.chapterNumber ?? 0);
  }
  if (parsed.chapterNumber !== undefined) return parsed.chapterNumber;
  return 1_000_000_000_000 + fallbackIndex;
}

export async function inspectLocalSeriesImport(
  files: readonly File[],
  novels: readonly Novel[],
  options: { readonly password?: string; readonly targetNovel?: Novel } = {},
): Promise<LocalSeriesImportInspection | undefined> {
  if (!files.length || files.some((file) => !isArchiveFile(file))) return undefined;
  let sourceKind: LocalSeriesSourceKind = files.length > 1 ? 'selected_archives' : 'selected_archives';
  const releaseFiles: File[] = [];
  for (const file of files) {
    const nested = await childArchiveFiles(file, options.password);
    if (nested) {
      sourceKind = 'nested_package';
      releaseFiles.push(...nested);
    } else {
      releaseFiles.push(file);
    }
  }
  if (sourceKind === 'selected_archives' && releaseFiles.length === 1 && !options.targetNovel) {
    const single = parseSerialReleaseName(releaseFiles[0]!.name);
    if (!single.releaseKey || !single.workTitle) return undefined;
  }

  const outerTitle =
    options.targetNovel?.title ?? (files.length === 1 ? parseSerialReleaseName(files[0]!.name).workTitle : undefined);
  const firstPass = releaseFiles.map((file) => parseSerialReleaseName(file.name, outerTitle));
  const commonTitle = options.targetNovel?.title ?? mostCommonExplicitTitle(firstPass) ?? outerTitle;
  if (!commonTitle) return undefined;
  const parsedReleases = releaseFiles.map((file) => parseSerialReleaseName(file.name, commonTitle));
  const mismatchedExplicitTitle = parsedReleases.some(
    (parsed) =>
      parsed.releaseKey &&
      parsed.workTitle &&
      parsed.confidence === 'high' &&
      normalizeSerialWorkKey(parsed.workTitle) !== normalizeSerialWorkKey(commonTitle),
  );
  if (mismatchedExplicitTitle && !options.targetNovel) return undefined;

  const { openImageArchiveStream } = await import('@noveldesk/fixed-document-core');
  const releases: LocalSeriesReleaseCandidate[] = [];
  for (const [index, file] of releaseFiles.entries()) {
    const parsed = parsedReleases[index]!;
    const document = await openImageArchiveStream(file, { fileName: file.name, password: options.password });
    const contentHash = await sha256(await file.arrayBuffer());
    const releaseKey = parsed.releaseKey ?? unknownReleaseKey(parsed);
    releases.push({
      id: stableId('local_series_release', `${normalizeSerialWorkKey(commonTitle)}:${releaseKey}`, 20),
      file,
      originalName: file.name,
      parsed,
      releaseKey,
      contentHash,
      pageCount: document.pages.length,
    });
  }
  if (!releases.length) return undefined;
  const confidence = parsedReleases.some((parsed) => parsed.confidence === 'low')
    ? 'low'
    : parsedReleases.some((parsed) => parsed.confidence === 'medium')
      ? 'medium'
      : 'high';
  return {
    sourceKind,
    workTitle: commonTitle,
    normalizedWorkKey: normalizeSerialWorkKey(commonTitle),
    confidence,
    releases,
    candidateNovels: options.targetNovel ? [options.targetNovel] : candidateNovelsForTitle(novels, commonTitle),
    sourceFileNames: files.map((file) => file.name),
  };
}

export const readLocalSeriesManifest = readSeriesImageArchiveManifest;

function existingReleaseKey(input: { readonly title: string; readonly chapterNumber?: number }): string {
  const parsed = parseSerialReleaseName(input.title);
  if (
    parsed.releaseKey &&
    (parsed.specialKind || parsed.volumeNumber !== undefined || parsed.seasonNumber !== undefined)
  ) {
    return parsed.releaseKey;
  }
  if (input.chapterNumber !== undefined) return `c:${input.chapterNumber}`;
  return parsed.releaseKey ?? `title:${normalizeSerialWorkKey(input.title)}`;
}

export async function planLocalSeriesImport(
  inspection: LocalSeriesImportInspection,
  targetNovel: Novel | undefined,
  assets: BookAssetRepository | undefined,
  options: PlanLocalSeriesImportOptions = {},
): Promise<LocalSeriesImportPlan> {
  const incrementalAppend = Boolean(targetNovel && options.incrementalAppend);
  const targetSource =
    targetNovel && !incrementalAppend
      ? await (await import('../../repositories/comic-source-export')).exportPortableBookSource(assets, targetNovel.id)
      : undefined;
  if (targetNovel && !incrementalAppend && !targetSource) {
    throw new Error('기존 작품의 원본을 찾지 못해 회차를 안전하게 추가할 수 없습니다.');
  }
  if (incrementalAppend && !options.existingChapters?.some((chapter) => chapter.documentSectionId)) {
    throw new Error('기존 작품의 회차 구조를 확인하지 못해 회차를 안전하게 추가할 수 없습니다.');
  }
  const existingManifest = targetSource ? await readSeriesImageArchiveManifest(targetSource.blob) : undefined;
  const existingByKey = new Map<string, { title: string; hash?: string }>();
  const existingByRemoteId = new Map<string, { title: string; hash?: string }>();
  const existingHashes = new Set<string>();
  if (existingManifest) {
    for (const chapter of existingManifest.chapters) {
      existingByKey.set(existingReleaseKey(chapter), { title: chapter.title, hash: chapter.sourceContentHash });
      if (chapter.sourceContentHash) existingHashes.add(chapter.sourceContentHash.toLocaleLowerCase());
    }
  } else if (targetNovel && targetSource) {
    const parsed = parseSerialReleaseName(targetNovel.sourceFileName, targetNovel.title);
    const key = parsed.releaseKey ?? `title:${normalizeSerialWorkKey(parsed.releaseTitle)}`;
    const hash = targetNovel.sourceContentHash ?? targetNovel.rawTextHash;
    existingByKey.set(key, { title: parsed.releaseTitle, hash });
    existingHashes.add(hash.toLocaleLowerCase());
  } else if (incrementalAppend) {
    const seenSections = new Set<string>();
    for (const chapter of options.existingChapters ?? []) {
      const remoteId = chapter.documentSectionId;
      if (!remoteId || seenSections.has(remoteId)) continue;
      seenSections.add(remoteId);
      const title = chapter.documentSectionTitle ?? chapter.title;
      const hash = chapter.documentSectionSourceContentHash;
      existingByRemoteId.set(remoteId, { title, hash });
      existingByKey.set(existingReleaseKey({ title }), { title, hash });
      if (hash) existingHashes.add(hash.toLocaleLowerCase());
    }
  }

  const selectedByKey = new Map<string, LocalSeriesReleaseCandidate>();
  const selectedHashes = new Set<string>();
  const releases: LocalSeriesPlannedRelease[] = [];
  for (const release of inspection.releases) {
    const hashKey = release.contentHash.toLocaleLowerCase();
    const existing = existingByRemoteId.get(release.id) ?? existingByKey.get(release.releaseKey);
    const selected = selectedByKey.get(release.releaseKey);
    let disposition: LocalSeriesReleaseDisposition = 'add';
    let existingTitle: string | undefined;
    if (existingHashes.has(hashKey) || selectedHashes.has(hashKey)) {
      disposition = 'duplicate';
      existingTitle = existing?.title ?? selected?.parsed.releaseTitle;
    } else if (existing || selected) {
      disposition = existing?.hash?.toLocaleLowerCase() === hashKey ? 'duplicate' : 'conflict';
      existingTitle = existing?.title ?? selected?.parsed.releaseTitle;
    }
    releases.push({ ...release, disposition, existingTitle });
    if (disposition === 'add') {
      selectedByKey.set(release.releaseKey, release);
      selectedHashes.add(hashKey);
    }
  }
  return {
    inspection,
    targetNovel,
    targetSource,
    existingManifest,
    incrementalAppend,
    releases,
    addCount: releases.filter((release) => release.disposition === 'add').length,
    duplicateCount: releases.filter((release) => release.disposition === 'duplicate').length,
    conflictCount: releases.filter((release) => release.disposition === 'conflict').length,
  };
}

export async function buildLocalSeriesImportFile(
  plan: LocalSeriesImportPlan,
  signal: AbortSignal,
  archivePassword?: string,
): Promise<File | undefined> {
  const additions = plan.releases.filter((release) => release.disposition === 'add');
  if (!additions.length) return undefined;
  const workKey = plan.inspection.normalizedWorkKey;
  const chapters: SeriesImageChapterInput[] = additions.map((release, index) => ({
    remoteId:
      plan.incrementalAppend && plan.targetNovel
        ? stableId('local_series_release', `${plan.targetNovel.id}:${release.releaseKey}`, 20)
        : release.id,
    release: {
      title: release.parsed.releaseTitle,
      chapterNumber: release.parsed.chapterNumber,
      sourceOrder: releaseSourceOrder(release.parsed, index + 1),
    },
    sourceContentHash: release.contentHash,
    file: release.file,
    archivePassword,
  }));
  const existingLegacyChapter =
    plan.targetNovel && plan.targetSource && !plan.existingManifest
      ? (() => {
          const parsed = parseSerialReleaseName(plan.targetNovel!.sourceFileName, plan.targetNovel!.title);
          return {
            remoteId: stableId(
              'local_series_release',
              `${workKey}:${parsed.releaseKey ?? `title:${normalizeSerialWorkKey(parsed.releaseTitle)}`}`,
              20,
            ),
            release: {
              title: parsed.releaseTitle,
              chapterNumber: parsed.chapterNumber,
              sourceOrder: releaseSourceOrder(parsed, 0),
            },
            sourceContentHash: plan.targetNovel!.sourceContentHash ?? plan.targetNovel!.rawTextHash,
            archivePassword,
          };
        })()
      : undefined;
  return buildSeriesImageArchive({
    collection: {
      remoteId: plan.existingManifest?.collection.remoteId ?? stableId('local_series', workKey, 20),
      title: plan.targetNovel?.title ?? plan.inspection.workTitle,
      author: plan.targetNovel?.author,
      description: plan.targetNovel?.description,
      tags: plan.targetNovel?.tags,
    },
    targetBookId: plan.incrementalAppend ? plan.targetNovel?.id : undefined,
    chapters,
    existingArchive: plan.incrementalAppend ? undefined : plan.targetSource?.blob,
    existingLegacyChapter: plan.incrementalAppend ? undefined : existingLegacyChapter,
    signal,
  });
}
