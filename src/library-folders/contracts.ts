export const LIBRARY_FOLDER_FORMATS = ['text', 'epub', 'pdf', 'zip', 'rar', '7z'] as const;

export type LibraryFolderFormat = (typeof LIBRARY_FOLDER_FORMATS)[number];
export type LibraryFolderProviderKind = 'browser-directory' | 'android-saf';

export interface LibraryFolderFilter {
  readonly formats: readonly LibraryFolderFormat[];
  readonly minBytes?: number;
  readonly maxBytes?: number;
  readonly recursive: boolean;
}

export interface LinkedLibraryFolder {
  readonly id: string;
  readonly providerKind: LibraryFolderProviderKind;
  readonly displayName: string;
  readonly filter: LibraryFolderFilter;
  readonly autoSync: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastScanAt?: string;
  readonly lastError?: string;
}

export interface LibraryFolderSourceEntry {
  /** Provider-local stable key. This is never included in cloud sync. */
  readonly sourceKey: string;
  readonly relativePath: string;
  readonly fileName: string;
  readonly mimeType?: string;
  readonly byteLength: number;
  readonly lastModified: number;
  /** Optional hash of the exact file bytes. Prefer `sha256:<lowercase hex>`. */
  readonly contentHash?: string;
  /** Per-file read/hash failure captured without aborting the whole folder scan. */
  readonly readError?: string;
}

export type LibraryFolderEntryStatus = 'linked' | 'missing' | 'failed';

export interface StoredLibraryFolderEntry extends LibraryFolderSourceEntry {
  readonly id: string;
  readonly folderId: string;
  readonly signature: string;
  readonly bookId?: string;
  readonly status: LibraryFolderEntryStatus;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly lastImportedAt?: string;
  readonly error?: string;
}

export type LibraryFolderCandidateStatus =
  | 'new'
  | 'changed'
  | 'unchanged'
  | 'missing'
  | 'update-existing'
  | 'failed'
  | 'unsupported'
  | 'below-minimum'
  | 'above-maximum';

export interface LibraryFolderCandidate extends LibraryFolderSourceEntry {
  readonly id: string;
  readonly folderId: string;
  readonly format?: LibraryFolderFormat;
  readonly status: LibraryFolderCandidateStatus;
  readonly selected: boolean;
  readonly bookId?: string;
  readonly existingBookTitle?: string;
}

export interface PickedLibraryFolder {
  readonly id: string;
  readonly providerKind: LibraryFolderProviderKind;
  readonly displayName: string;
}

export interface ScanLibraryFolderOptions {
  readonly requestPermission: boolean;
  readonly recursive: boolean;
}

export interface PlatformLibraryFolderIo {
  readonly available: boolean;
  readonly providerKind: LibraryFolderProviderKind;
  pickFolder(): Promise<PickedLibraryFolder | undefined>;
  scanFolder(folder: LinkedLibraryFolder, options: ScanLibraryFolderOptions): Promise<LibraryFolderSourceEntry[]>;
  readFile(folder: LinkedLibraryFolder, entry: LibraryFolderSourceEntry): Promise<File>;
  forgetFolder(folder: LinkedLibraryFolder): Promise<void>;
}

export const DEFAULT_LIBRARY_FOLDER_FILTER: LibraryFolderFilter = {
  formats: [...LIBRARY_FOLDER_FORMATS],
  recursive: true,
};

export function libraryFolderFormatForName(fileName: string): LibraryFolderFormat | undefined {
  const extension = fileName.split('.').pop()?.toLocaleLowerCase();
  if (extension === 'txt' || extension === 'md' || extension === 'markdown') return 'text';
  if (extension === 'epub') return 'epub';
  if (extension === 'pdf') return 'pdf';
  if (extension === 'zip' || extension === 'cbz') return 'zip';
  if (extension === 'rar' || extension === 'cbr') return 'rar';
  if (extension === '7z' || extension === 'cb7') return '7z';
  return undefined;
}

export function libraryFolderEntryId(folderId: string, sourceKey: string): string {
  return `${folderId}::${sourceKey}`;
}

export function libraryFolderEntrySignature(entry: LibraryFolderSourceEntry): string {
  return [entry.sourceKey, entry.byteLength, entry.lastModified, entry.contentHash?.trim().toLocaleLowerCase() ?? '']
    .map(String)
    .join('\u0000');
}
