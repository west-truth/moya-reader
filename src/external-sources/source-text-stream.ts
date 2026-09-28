import type { SourceStreamPort } from './source-stream';

/** A novel source returns one chapter of plain text; no library import is required. */
export interface SourceTextStreamPort {
  readonly kind: 'text';
  open(remoteId: string, signal: AbortSignal): Promise<{ text: string }>;
}
export type SourceReadingPort = SourceStreamPort | SourceTextStreamPort;
export function isTextStream(port: SourceReadingPort): port is SourceTextStreamPort {
  return 'kind' in port && port.kind === 'text';
}
