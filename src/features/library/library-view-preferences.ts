import type { LibrarySort, LibraryViewMode } from './library-screen-model';

const KEY = 'moya.library-view.v1';
interface LibraryViewPreferences {
  librarySort?: LibrarySort;
  libraryViewMode?: LibraryViewMode;
}

export function readLibraryViewPreferences(): LibraryViewPreferences {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    if (!value || typeof value !== 'object') return {};
    const preferences = value as Record<string, unknown>;
    return {
      ...(preferences.librarySort === 'recent' ||
      preferences.librarySort === 'title' ||
      preferences.librarySort === 'added'
        ? { librarySort: preferences.librarySort }
        : {}),
      ...(preferences.libraryViewMode === 'grid' || preferences.libraryViewMode === 'list'
        ? { libraryViewMode: preferences.libraryViewMode }
        : {}),
    };
  } catch {
    return {};
  }
}

export function saveLibraryViewPreferences(patch: LibraryViewPreferences): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...readLibraryViewPreferences(), ...patch }));
  } catch {
    // A blocked/full device store must not prevent changing the current Library view.
  }
}
