import type {
  ExternalSourceDownloadRef,
  ExternalSourceCollectionDescriptor,
  ExternalSourceReleaseDescriptor,
} from '../../external-sources/contracts';
import type { ImportFileInput } from './import-service';

/** An opaque server-owned artifact. No file bytes or filesystem paths cross this boundary. */
export interface HostedImageDownload {
  artifactId: string;
  sourceContentHash: string;
  byteLength: number;
  remoteRevision?: string;
}

export interface PreparedServerImport {
  uploadId: string;
  sourceContentHash: string;
  byteLength: number;
}

export type HostedImageAssembly = Pick<
  ImportFileInput,
  'clientBookId' | 'importMode' | 'baseActiveContentRevisionId'
> & {
  artifactId: string;
  collection: ExternalSourceCollectionDescriptor;
  remoteId: string;
  release: ExternalSourceReleaseDescriptor;
  remoteRevision?: string;
  expectedPreviousSourceContentHash?: string;
};

export interface HostedImageImportPort {
  download(ref: ExternalSourceDownloadRef, signal: AbortSignal): Promise<HostedImageDownload>;
  assemble(input: HostedImageAssembly, signal: AbortSignal): Promise<PreparedServerImport>;
  discard(artifactId: string): Promise<void>;
}
