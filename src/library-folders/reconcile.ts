import type { Novel } from '../domain/types';
import {
  libraryFolderEntryId,
  libraryFolderEntrySignature,
  libraryFolderFormatForName,
  type LibraryFolderCandidate,
  type LibraryFolderSourceEntry,
  type LinkedLibraryFolder,
  type StoredLibraryFolderEntry,
} from './contracts';

export interface LibraryFolderReconcileResult {
  readonly candidates: readonly LibraryFolderCandidate[];
  readonly observedEntries: readonly StoredLibraryFolderEntry[];
  readonly retiredEntryIds: readonly string[];
}

function normalizedName(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function eligibleStatus(
  folder: LinkedLibraryFolder,
  entry: LibraryFolderSourceEntry,
): LibraryFolderCandidate['status'] | undefined {
  const format = libraryFolderFormatForName(entry.fileName);
  if (!format || !folder.filter.formats.includes(format)) return 'unsupported';
  if (folder.filter.minBytes !== undefined && entry.byteLength < folder.filter.minBytes) return 'below-minimum';
  if (folder.filter.maxBytes !== undefined && entry.byteLength > folder.filter.maxBytes) return 'above-maximum';
  return undefined;
}

function sameQuickIdentity(a: LibraryFolderSourceEntry, b: LibraryFolderSourceEntry): boolean {
  return a.byteLength === b.byteLength && a.lastModified === b.lastModified;
}

function normalizedContentHash(entry: LibraryFolderSourceEntry): string | undefined {
  const value = entry.contentHash?.trim().toLocaleLowerCase();
  if (!value) return undefined;
  return value.startsWith('sha256:') ? value : `sha256:${value}`;
}

function sameSourceVersion(a: LibraryFolderSourceEntry, b: StoredLibraryFolderEntry): boolean {
  const currentHash = normalizedContentHash(a);
  const storedHash = normalizedContentHash(b);
  if (currentHash) return Boolean(storedHash && currentHash === storedHash);
  return sameQuickIdentity(a, b);
}

function extension(value: string): string {
  return value.split('.').pop()?.toLocaleLowerCase() ?? '';
}

function renameCandidate(
  entry: LibraryFolderSourceEntry,
  missing: readonly StoredLibraryFolderEntry[],
  newSources: readonly LibraryFolderSourceEntry[],
): StoredLibraryFolderEntry | undefined {
  const contentHash = normalizedContentHash(entry);
  const matches = missing.filter(
    (stored) =>
      stored.bookId &&
      extension(stored.fileName) === extension(entry.fileName) &&
      (contentHash ? normalizedContentHash(stored) === contentHash : sameQuickIdentity(entry, stored)),
  );
  if (!contentHash) {
    const weakSourceMatches = newSources.filter(
      (source) => extension(source.fileName) === extension(entry.fileName) && sameQuickIdentity(entry, source),
    );
    if (weakSourceMatches.length !== 1) return undefined;
  }
  return matches.length === 1 ? matches[0] : undefined;
}

export function reconcileLibraryFolderScan(input: {
  readonly folder: LinkedLibraryFolder;
  readonly sourceEntries: readonly LibraryFolderSourceEntry[];
  readonly storedEntries: readonly StoredLibraryFolderEntry[];
  readonly novels: readonly Novel[];
  readonly scannedAt: string;
}): LibraryFolderReconcileResult {
  const storedByKey = new Map(input.storedEntries.map((entry) => [entry.sourceKey, entry]));
  const sourceKeys = new Set(input.sourceEntries.map((entry) => entry.sourceKey));
  const missing = input.storedEntries.filter((entry) => !sourceKeys.has(entry.sourceKey));
  const newSources = input.sourceEntries.filter((entry) => !storedByKey.has(entry.sourceKey));
  const claimedRenameIds = new Set<string>();
  const retiredEntryIds: string[] = [];
  const observedEntries: StoredLibraryFolderEntry[] = [];
  const candidates: LibraryFolderCandidate[] = [];
  const novelsByName = new Map<string, Novel[]>();
  input.novels.forEach((novel) => {
    const key = normalizedName(novel.sourceFileName);
    novelsByName.set(key, [...(novelsByName.get(key) ?? []), novel]);
  });

  for (const source of input.sourceEntries) {
    const excludedStatus = eligibleStatus(input.folder, source);
    let stored = storedByKey.get(source.sourceKey);
    if (!stored && !excludedStatus) {
      const renamed = renameCandidate(
        source,
        missing.filter((entry) => !claimedRenameIds.has(entry.id)),
        newSources,
      );
      if (renamed) {
        stored = renamed;
        claimedRenameIds.add(renamed.id);
        retiredEntryIds.push(renamed.id);
      }
    }

    const format = libraryFolderFormatForName(source.fileName);
    const sameContentMetadata = stored ? sameSourceVersion(source, stored) : false;
    const existingByName = novelsByName.get(normalizedName(source.fileName));
    const uniqueExisting = existingByName?.length === 1 ? existingByName[0] : undefined;
    const status = excludedStatus
      ? excludedStatus
      : source.readError
        ? 'failed'
        : stored?.bookId
          ? sameContentMetadata && stored.status !== 'failed'
            ? 'unchanged'
            : 'changed'
          : uniqueExisting
            ? 'update-existing'
            : 'new';
    const bookId = stored?.bookId ?? (status === 'update-existing' ? uniqueExisting?.id : undefined);

    candidates.push({
      ...source,
      id: libraryFolderEntryId(input.folder.id, source.sourceKey),
      folderId: input.folder.id,
      format,
      status,
      selected: status === 'new' || status === 'changed' || status === 'update-existing',
      bookId,
      existingBookTitle: bookId ? input.novels.find((novel) => novel.id === bookId)?.title : undefined,
    });

    if (stored) {
      observedEntries.push({
        ...stored,
        ...(excludedStatus ? {} : source),
        id: libraryFolderEntryId(input.folder.id, excludedStatus ? stored.sourceKey : source.sourceKey),
        folderId: input.folder.id,
        signature: excludedStatus || source.readError ? stored.signature : libraryFolderEntrySignature(source),
        status: source.readError ? stored.status : stored.status === 'failed' ? 'failed' : 'linked',
        lastSeenAt: input.scannedAt,
        readError: source.readError,
        error: stored.status === 'failed' && sameContentMetadata ? stored.error : undefined,
      });
    }
  }

  for (const stored of missing) {
    if (claimedRenameIds.has(stored.id)) continue;
    observedEntries.push({ ...stored, status: 'missing' });
    candidates.push({
      ...stored,
      id: stored.id,
      folderId: input.folder.id,
      format: libraryFolderFormatForName(stored.fileName),
      status: 'missing',
      selected: false,
      existingBookTitle: stored.bookId ? input.novels.find((novel) => novel.id === stored.bookId)?.title : undefined,
    });
  }

  candidates.sort((a, b) => {
    const rank = (candidate: LibraryFolderCandidate) =>
      candidate.status === 'changed' || candidate.status === 'update-existing'
        ? 0
        : candidate.status === 'failed'
          ? 0
          : candidate.status === 'new'
            ? 1
            : candidate.status === 'missing'
              ? 3
              : 2;
    return rank(a) - rank(b) || a.relativePath.localeCompare(b.relativePath);
  });
  return { candidates, observedEntries, retiredEntryIds };
}
