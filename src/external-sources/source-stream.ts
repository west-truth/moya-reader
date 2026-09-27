export interface SourceStreamSession {
  readonly pageCount: number;
  loadPage(index: number, signal: AbortSignal): Promise<Blob>;
  close(): void;
}
export interface SourceStreamPort {
  open(remoteId: string, signal: AbortSignal): Promise<SourceStreamSession>;
}
