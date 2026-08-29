import { BlobReader, BlobWriter, ZipReader, type FileEntry } from '@zip.js/zip.js';

const DOCUMENT_FILE = /\.(?:txt|md|markdown|epub)$/iu;
const ZIP_FILE = /\.zip$/iu;
const IMAGE_FILE = /\.(?:avif|gif|jpe?g|png|webp)$/iu;
const DOCUMENT_SERIES_MANIFEST = /(?:^|\/)moya-document-series\.json$/iu;
const MAX_DOCUMENT_ENTRIES = 512;
const MAX_DOCUMENT_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_DOCUMENT_BYTES = 1024 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 250;

export interface ExpandedDocumentBundle {
  readonly files: readonly File[];
  readonly archiveWorkTitle?: string;
  readonly fromArchive: boolean;
}

function normalizedArchivePath(value: string): string {
  const clean = value.replace(/\\/gu, '/').normalize('NFKC').trim();
  if (!clean || clean.startsWith('/') || /^[a-z][a-z0-9+.-]*:/iu.test(clean)) {
    throw new Error('문서 묶음 ZIP에 허용되지 않는 절대 경로가 있습니다.');
  }
  const parts: string[] = [];
  for (const part of clean.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') throw new Error('문서 묶음 ZIP의 항목이 압축 파일 밖을 가리킵니다.');
    parts.push(part);
  }
  if (!parts.length) throw new Error('문서 묶음 ZIP에 빈 항목 경로가 있습니다.');
  return parts.join('/');
}

function archiveTitle(fileName: string): string {
  return fileName.replace(/\.zip$/iu, '').trim();
}

function contentType(fileName: string): string {
  if (/\.epub$/iu.test(fileName)) return 'application/epub+zip';
  if (/\.(?:md|markdown)$/iu.test(fileName)) return 'text/markdown';
  return 'text/plain';
}

async function documentFilesFromArchive(file: File, password?: string): Promise<File[] | undefined> {
  const reader = new ZipReader(new BlobReader(file), { password });
  try {
    const entries = await reader.getEntries();
    if (entries.some((entry) => !entry.directory && DOCUMENT_SERIES_MANIFEST.test(entry.filename))) return undefined;
    const documents = entries.filter(
      (entry): entry is FileEntry =>
        !entry.directory && DOCUMENT_FILE.test(entry.filename) && Boolean((entry as FileEntry).getData),
    );
    if (!documents.length) return undefined;
    const imageCount = entries.filter((entry) => !entry.directory && IMAGE_FILE.test(entry.filename)).length;
    if (documents.length === 1 && imageCount > 0) return undefined;
    if (documents.length > MAX_DOCUMENT_ENTRIES) {
      throw new Error('문서 묶음 ZIP의 문서 수가 안전 한도를 초과했습니다.');
    }

    let totalBytes = 0;
    const files: File[] = [];
    const paths = new Set<string>();
    for (const entry of documents.sort((left, right) =>
      left.filename.localeCompare(right.filename, 'ko', { numeric: true }),
    )) {
      const path = normalizedArchivePath(entry.filename);
      const pathKey = path.toLocaleLowerCase();
      if (paths.has(pathKey)) throw new Error('문서 묶음 ZIP에 중복 경로가 있습니다.');
      paths.add(pathKey);
      const size = Number(entry.uncompressedSize ?? 0);
      const compressed = Math.max(1, Number(entry.compressedSize ?? size));
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_DOCUMENT_BYTES) {
        throw new Error(`${path} 문서의 크기가 안전 한도를 벗어났습니다.`);
      }
      if (size > compressed * MAX_COMPRESSION_RATIO) {
        throw new Error(`${path} 문서의 압축률이 안전 한도를 초과했습니다.`);
      }
      totalBytes += size;
      if (totalBytes > MAX_TOTAL_DOCUMENT_BYTES) {
        throw new Error('문서 묶음 ZIP의 전체 압축 해제 크기가 안전 한도를 초과했습니다.');
      }
      if (entry.encrypted && !password) throw new Error('문서 묶음 ZIP에 암호가 필요합니다.');
      const name = path.split('/').at(-1) ?? path;
      const blob = await entry.getData!(new BlobWriter(contentType(name)));
      files.push(new File([blob], name, { type: contentType(name), lastModified: file.lastModified }));
    }
    return files;
  } finally {
    await reader.close().catch(() => undefined);
  }
}

export async function expandDocumentBundleFiles(
  selectedFiles: readonly File[],
  password?: string,
): Promise<ExpandedDocumentBundle | undefined> {
  if (
    !selectedFiles.length ||
    selectedFiles.some((file) => !DOCUMENT_FILE.test(file.name) && !ZIP_FILE.test(file.name))
  ) {
    return undefined;
  }
  const files: File[] = [];
  let archiveCount = 0;
  let singleArchiveTitle: string | undefined;
  for (const file of selectedFiles) {
    if (DOCUMENT_FILE.test(file.name)) {
      files.push(file);
      continue;
    }
    const archived = await documentFilesFromArchive(file, password);
    if (!archived) return undefined;
    files.push(...archived);
    archiveCount += 1;
    singleArchiveTitle = archiveTitle(file.name);
  }
  return {
    files,
    archiveWorkTitle: archiveCount === 1 && selectedFiles.length === 1 ? singleArchiveTitle : undefined,
    fromArchive: archiveCount > 0,
  };
}
