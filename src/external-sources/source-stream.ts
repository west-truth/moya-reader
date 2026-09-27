export interface SourceStreamSession {
  readonly pageCount: number;
  loadPage(index: number, signal: AbortSignal): Promise<Blob>;
  /** Discard bytes that the viewer could not decode before retrying this page. */
  invalidatePage?(index: number): void;
  close(): void;
}
export interface SourceStreamPort {
  open(remoteId: string, signal: AbortSignal): Promise<SourceStreamSession>;
}
