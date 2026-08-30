import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_COMIC_READING_PROFILE } from '../features/fixed-document/comic-layout';
import { IndexedDbComicReadingProfileRepository } from './comic-reading-profile-store';
import { resetReaderDbForTests } from './reader-database';

describe('comic reading profile store', () => {
  beforeEach(async () => resetReaderDbForTests());

  it('reuses display settings globally while keeping detected page crops with their book', async () => {
    const repository = new IndexedDbComicReadingProfileRepository();
    await repository.save('book-a', {
      ...DEFAULT_COMIC_READING_PROFILE,
      mode: 'vertical',
      seamlessVertical: true,
      fit: 'width',
      background: 'black',
      pageCrops: { '3': { top: 0.01, right: 0.02, bottom: 0.03, left: 0.04 } },
    });

    await expect(repository.get('book-b')).resolves.toMatchObject({
      mode: 'vertical',
      seamlessVertical: true,
      fit: 'width',
      background: 'black',
      pageCrops: undefined,
    });
    await expect(repository.get('book-a')).resolves.toMatchObject({
      pageCrops: { '3': { top: 0.01, right: 0.02, bottom: 0.03, left: 0.04 } },
    });
  });
});
