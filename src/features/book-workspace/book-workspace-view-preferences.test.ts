import { afterEach, describe, expect, it, vi } from 'vitest';
import { readLibraryViewPreferences } from '../library/library-view-preferences';
import { BookWorkspaceController } from './book-workspace-controller';
import { createBookWorkspaceTestHarness } from './book-workspace-test-fixtures';

afterEach(() => vi.unstubAllGlobals());

describe('device-local Library view preferences', () => {
  it.each(['grid', 'compact', 'list', 'text'] as const)(
    'restores %s layout without persisting queries or selection',
    (viewMode) => {
      const values = new Map<string, string>();
      vi.stubGlobal('localStorage', {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      });
      const { ports } = createBookWorkspaceTestHarness();
      const first = new BookWorkspaceController(ports);
      first.setLibraryViewMode(viewMode);
      first.setLibrarySort('title');
      first.setLibraryQuery('private search');
      first.setLibraryFilter('trash');
      const reloaded = new BookWorkspaceController(ports);
      expect(reloaded.getSnapshot()).toMatchObject({
        librarySort: 'title',
        libraryViewMode: viewMode,
        libraryQuery: '',
        libraryFilter: 'all',
      });
      reloaded.setLibrarySort('added');
      expect(new BookWorkspaceController(ports).getSnapshot()).toMatchObject({
        librarySort: 'added',
        libraryViewMode: viewMode,
      });
      expect([...values.values()].join()).not.toContain('private search');
      expect(values.size).toBe(1);
      // A different device storage starts with the default view.
      values.clear();
      expect(new BookWorkspaceController(ports).getSnapshot()).toMatchObject({
        librarySort: 'recent',
        libraryViewMode: 'grid',
      });
    },
  );

  it('validates saved fields independently and tolerates inaccessible or corrupt device storage', () => {
    vi.stubGlobal('localStorage', { getItem: () => '{"librarySort":"unknown","libraryViewMode":"list"}' });
    expect(readLibraryViewPreferences()).toEqual({ libraryViewMode: 'list' });
    vi.stubGlobal('localStorage', { getItem: () => '{broken' });
    expect(readLibraryViewPreferences()).toEqual({});
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('full');
      },
    });
    const controller = new BookWorkspaceController(createBookWorkspaceTestHarness().ports);
    controller.setLibrarySort('added');
    controller.setLibraryViewMode('list');
    expect(controller.getSnapshot()).toMatchObject({ librarySort: 'added', libraryViewMode: 'list' });
  });
});
