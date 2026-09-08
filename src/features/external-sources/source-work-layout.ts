export type SourceWorkLayout = 'cards' | 'covers' | 'list';
const STORAGE_KEY = 'noveldesk.external-source-work-layout.v1';

export function readSourceWorkLayout(): SourceWorkLayout {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'covers' || value === 'list' ? value : 'cards';
  } catch {
    return 'cards';
  }
}

export function saveSourceWorkLayout(value: SourceWorkLayout): void {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Presentation remains usable when browser storage is unavailable.
  }
}
