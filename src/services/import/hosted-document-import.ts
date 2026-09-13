import type { ExternalItemSummary, ExternalSourceDownloadRef } from '../../external-sources/contracts';
import type { DocumentSeriesAssemblyResult } from '../../external-sources/series/document-series-assembler';
import type { ImportExpectedBase } from './import-service';
import type { HostedImageDownload, PreparedServerImport } from './hosted-image-import';

/** Optional host transport; installed extensions keep the ordinary document content contract. */
export interface HostedDocumentAssembly {
  artifactId: string;
  item: ExternalItemSummary;
  targetBookId: string;
  expectedBase: ImportExpectedBase;
  expectedPreviousSourceContentHash?: string | null;
}

export interface HostedDocumentAssemblyResult extends Omit<DocumentSeriesAssemblyResult, 'file'> {
  prepared?: PreparedServerImport;
  sourceContentHash: string;
}

export interface HostedDocumentImportPort {
  download(ref: ExternalSourceDownloadRef, signal: AbortSignal): Promise<HostedImageDownload>;
  assemble(input: HostedDocumentAssembly, signal: AbortSignal): Promise<HostedDocumentAssemblyResult>;
  discard(artifactId: string): Promise<void>;
  cancelPrepared(uploadId: string): Promise<void>;
}
