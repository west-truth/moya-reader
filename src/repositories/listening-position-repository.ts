import type { DocumentAnchor, ListeningPosition } from '../domain/types';

export interface SaveListeningPositionInput {
  readonly bookId: string;
  readonly chapterId: string;
  readonly anchor: DocumentAnchor;
  readonly queueItemFingerprint: string;
  readonly contentRevisionId: string;
  readonly settingsFingerprint: string;
  readonly deviceId?: string;
  readonly updatedAt?: string;
}

export interface ListeningPositionRepository {
  get(bookId: string): Promise<ListeningPosition | undefined>;
  save(input: SaveListeningPositionInput): Promise<ListeningPosition>;
  clear(bookId: string): Promise<void>;
  remap(bookId: string, anchor: DocumentAnchor, contentRevisionId: string): Promise<ListeningPosition | undefined>;
}
