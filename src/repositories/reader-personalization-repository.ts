import type { ReadingSessionEvent, UserFontAsset } from '../domain/types';

export interface InstallUserFontInput {
  readonly asset: UserFontAsset;
  readonly blob: Blob;
}

export interface ReaderPersonalizationRepository {
  listUserFonts(): Promise<UserFontAsset[]>;
  getUserFontContent(id: string): Promise<Blob | undefined>;
  installUserFont(input: InstallUserFontInput): Promise<UserFontAsset>;
  updateUserFont(id: string, patch: Pick<UserFontAsset, 'familyLabel' | 'licenseNote'>): Promise<UserFontAsset>;
  deleteUserFont(id: string): Promise<void>;
  appendReadingSession(event: ReadingSessionEvent): Promise<void>;
  listReadingSessions(options?: { bookId?: string; from?: string; to?: string }): Promise<ReadingSessionEvent[]>;
  deleteReadingSessions(options?: { bookId?: string; before?: string }): Promise<number>;
}
