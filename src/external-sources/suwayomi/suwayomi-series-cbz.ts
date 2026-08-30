import type { ExternalSourceCollectionDescriptor, ExternalSourceReleaseDescriptor } from '../contracts';
import {
  buildSeriesImageArchive,
  type SeriesImageArchiveManifest,
  type SeriesImageManifestChapter,
} from '../../services/import/series-image-archive';

export interface SuwayomiSeriesChapterInput {
  readonly remoteId: string;
  readonly release: ExternalSourceReleaseDescriptor;
  readonly remoteRevision?: string;
  readonly sourceContentHash: string;
  readonly expectedPreviousSourceContentHash?: string;
  readonly file: Blob;
  /** Request-scoped only; used by local archive imports and never written to the manifest. */
  readonly archivePassword?: string;
}

export interface SuwayomiSeriesArchiveInput {
  readonly collection: ExternalSourceCollectionDescriptor;
  readonly targetBookId?: string;
  readonly chapters: readonly SuwayomiSeriesChapterInput[];
  readonly existingArchive?: Blob;
  readonly existingLegacyChapter?: Omit<SuwayomiSeriesChapterInput, 'file'>;
  readonly signal: AbortSignal;
}

export type SuwayomiSeriesManifestChapter = SeriesImageManifestChapter;
export type SuwayomiSeriesManifest = SeriesImageArchiveManifest & {
  readonly collection: ExternalSourceCollectionDescriptor;
};

export async function buildSuwayomiSeriesArchive(input: SuwayomiSeriesArchiveInput): Promise<File> {
  return buildSeriesImageArchive(input);
}
