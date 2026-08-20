import { sha256 } from '../../domain/hash';
import type { Novel } from '../../domain/types';

export const MAX_IMPORT_DUPLICATE_HASH_BYTES = 32 * 1024 * 1024;

export type ImportDuplicatePolicy = 'open_existing' | 'skip' | 'copy' | 'replace' | 'new';

export interface ImportDuplicateConflict {
  readonly fileKey: string;
  readonly fileName: string;
  readonly kind: 'same_source' | 'same_name';
  readonly existingBook: Novel;
  readonly sourceHash?: string;
  readonly policy: ImportDuplicatePolicy;
}

export function importFileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

export async function inspectImportDuplicates(
  files: readonly File[],
  novels: readonly Novel[],
): Promise<ImportDuplicateConflict[]> {
  const conflicts: ImportDuplicateConflict[] = [];
  for (const file of files) {
    const sameName = novels.find(
      (novel) => novel.sourceFileName?.trim().toLocaleLowerCase() === file.name.trim().toLocaleLowerCase(),
    );
    const sourceHash =
      file.size <= MAX_IMPORT_DUPLICATE_HASH_BYTES ? await sha256(await file.arrayBuffer()) : undefined;
    const sameSource = sourceHash
      ? novels.find((novel) => novel.rawTextHash.toLowerCase() === sourceHash.toLowerCase())
      : undefined;
    const existingBook = sameSource ?? sameName;
    if (!existingBook) continue;
    conflicts.push({
      fileKey: importFileKey(file),
      fileName: file.name,
      kind: sameSource ? 'same_source' : 'same_name',
      existingBook,
      sourceHash,
      policy: sameSource ? 'open_existing' : 'new',
    });
  }
  return conflicts;
}
