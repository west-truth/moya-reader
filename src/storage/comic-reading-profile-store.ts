import type { ComicReadingProfile } from '../domain/types';
import { DEFAULT_COMIC_READING_PROFILE } from '../features/fixed-document/comic-layout';
import { DOCUMENT_LISTENING_STORES } from './document-listening-schema';
import { getByIndex, putItem } from './indexeddb-transaction';

const GLOBAL_COMIC_PROFILE_BOOK_ID = '__moya_global_comic_profile__';

interface StoredComicReadingProfile extends ComicReadingProfile {
  readonly id: string;
  readonly bookId: string;
  readonly updatedAt: string;
}

function finiteRange(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}

function sanitizedPageCrops(value: ComicReadingProfile['pageCrops']): ComicReadingProfile['pageCrops'] {
  if (!value) return undefined;
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 5_000)
      .map(([page, crop]) => [
        page,
        {
          top: finiteRange(crop.top, 0, 0, 0.3),
          right: finiteRange(crop.right, 0, 0, 0.3),
          bottom: finiteRange(crop.bottom, 0, 0, 0.3),
          left: finiteRange(crop.left, 0, 0, 0.3),
        },
      ]),
  );
}

export class IndexedDbComicReadingProfileRepository {
  async get(bookId: string, fallback: Partial<ComicReadingProfile> = {}): Promise<ComicReadingProfile> {
    const [globalProfile, bookProfile] = await Promise.all([
      getByIndex<StoredComicReadingProfile>(
        DOCUMENT_LISTENING_STORES.comicProfiles,
        'bookId',
        GLOBAL_COMIC_PROFILE_BOOK_ID,
      ),
      getByIndex<StoredComicReadingProfile>(DOCUMENT_LISTENING_STORES.comicProfiles, 'bookId', bookId),
    ]);
    const stored = globalProfile
      ? { ...globalProfile, pageCrops: bookProfile?.pageCrops }
      : bookProfile
        ? bookProfile
        : undefined;
    if (!stored) return { ...DEFAULT_COMIC_READING_PROFILE, ...fallback };
    const profile: ComicReadingProfile = {
      ...DEFAULT_COMIC_READING_PROFILE,
      ...fallback,
      ...stored,
      brightness: finiteRange(stored.brightness, 1, 0.4, 1.8),
      contrast: finiteRange(stored.contrast, 1, 0.4, 2),
      saturation: finiteRange(stored.saturation, 1, 0, 2),
      gap: finiteRange(stored.gap, 8, 0, 48),
      manualCrop: {
        top: finiteRange(stored.manualCrop?.top, 0, 0, 0.3),
        right: finiteRange(stored.manualCrop?.right, 0, 0, 0.3),
        bottom: finiteRange(stored.manualCrop?.bottom, 0, 0, 0.3),
        left: finiteRange(stored.manualCrop?.left, 0, 0, 0.3),
      },
      pageCrops: sanitizedPageCrops(stored.pageCrops),
    };
    if (!globalProfile && bookProfile) await this.save(bookId, profile);
    return profile;
  }

  async save(bookId: string, profile: ComicReadingProfile): Promise<void> {
    const updatedAt = new Date().toISOString();
    await Promise.all([
      putItem(DOCUMENT_LISTENING_STORES.comicProfiles, {
        ...profile,
        pageCrops: undefined,
        id: `comic_profile_${GLOBAL_COMIC_PROFILE_BOOK_ID}`,
        bookId: GLOBAL_COMIC_PROFILE_BOOK_ID,
        updatedAt,
      } satisfies StoredComicReadingProfile),
      putItem(DOCUMENT_LISTENING_STORES.comicProfiles, {
        ...profile,
        id: `comic_profile_${bookId}`,
        bookId,
        updatedAt,
      } satisfies StoredComicReadingProfile),
    ]);
  }
}
