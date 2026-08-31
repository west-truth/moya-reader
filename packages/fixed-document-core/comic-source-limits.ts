// A work is an index of immutable archives, not one archive expanded in memory.
// Keep archive/page decoding limits in the archive parser; bound this index separately.
export const MAX_COMIC_SOURCE_PAGES = 20_000;
export const MAX_COMIC_SOURCE_PARTS = 2_000;
export const MAX_COMIC_SOURCE_MANIFEST_BYTES = 8 * 1024 * 1024;
