import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { externalItemKeyId } from '../../external-sources/contracts';
import { SourceReleasePanel } from './SourceReleasePanel';
import { filterAndSortReleases, paginateReleases } from './source-release-list-model';
import type { ExternalSourceController, ExternalSourceItemView } from './useExternalSourceController';

function releases(count: number): ExternalSourceItemView[] {
  return Array.from({ length: count }, (_, index) => ({
    key: { connectorId: 'fixture.source', remoteId: `release-${index + 1}` },
    kind: 'file',
    title: `${index + 1}화 이야기`,
    release: { title: `${index + 1}화 이야기`, sourceOrder: index + 1 },
    importability: 'supported',
    importState: 'available',
    selected: false,
    readingState: index === 0 ? 'read' : index === 1 ? 'current' : 'unread',
  }));
}
function control(overrides: Partial<ExternalSourceController> = {}): ExternalSourceController {
  return {
    open: true,
    loading: false,
    busy: false,
    blockingBusy: false,
    importBusy: false,
    loadMore: vi.fn(async () => undefined),
    selectAllSupported: vi.fn(),
    ...overrides,
  } as unknown as ExternalSourceController;
}
const renderItem = (item: ExternalSourceItemView) => <article key={externalItemKeyId(item.key)}>{item.title}</article>;

describe('source release lists', () => {
  it('sorts numeric and fractional chapters, preserves ties, and keeps local-only order separate', () => {
    const items = releases(4);
    const input = [
      { ...items[0]!, title: 'remote 100', release: { title: 'remote 100', chapterNumber: 100, sourceOrder: 0 } },
      { ...items[1]!, title: 'remote 2.5', release: { title: 'remote 2.5', chapterNumber: 2.5 } },
      { ...items[2]!, title: 'local 300', release: { title: 'local 300', sourceOrder: 1 }, localOrderOnly: true },
      { ...items[3]!, title: 'remote 2.5 alternate', release: { title: 'remote 2.5 alternate', chapterNumber: 2.5 } },
    ];
    expect(filterAndSortReleases(input, '', 'all', 'asc').map((item) => item.title)).toEqual([
      'remote 2.5',
      'remote 2.5 alternate',
      'remote 100',
      'local 300',
    ]);
    expect(filterAndSortReleases(input, '', 'all', 'desc').map((item) => item.title)).toEqual([
      'remote 100',
      'remote 2.5',
      'remote 2.5 alternate',
      'local 300',
    ]);
    expect(input[0]!.title).toBe('remote 100');
  });

  it('filters by title/number/read state and clamps empty/out-of-range pages', () => {
    const items = releases(125);
    expect(filterAndSortReleases(items, '１２５화', 'unread', 'asc').map((item) => item.key.remoteId)).toEqual([
      'release-125',
    ]);
    expect(filterAndSortReleases(items, '', 'read', 'desc')).toHaveLength(1);
    expect(filterAndSortReleases(items, '', 'unread', 'asc')[0]!.readingState).toBe('current');
    expect(paginateReleases(items, 100)).toMatchObject({ page: 13, rangeStart: 121, rangeEnd: 125 });
    expect(paginateReleases([], 9)).toMatchObject({ page: 1, pageCount: 1, rangeStart: 0, rangeEnd: 0, items: [] });
  });

  it.each(['text-source', 'suwayomi', 'local-comic'])(
    'renders only ten of 2,005 %s chapters and keeps sorting, filtering and page selection scoped',
    async (kind) => {
      const items = releases(2005).map((item) => ({ ...item, key: { ...item.key, connectorId: kind } }));
      const controller = control();
      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(<SourceReleasePanel controller={controller} items={items} renderItem={renderItem} />);
      });
      try {
        const rows = () => renderer.root.findAllByType('article').map((row) => row.children[0]);
        expect(rows()).toHaveLength(10);
        await act(async () => renderer.root.findByProps({ 'aria-label': '201페이지' }).props.onClick());
        expect(rows()).toEqual(['2001화 이야기', '2002화 이야기', '2003화 이야기', '2004화 이야기', '2005화 이야기']);
        await act(async () =>
          renderer.root.findByProps({ type: 'checkbox' }).props.onChange({ target: { checked: true } }),
        );
        expect(controller.selectAllSupported).toHaveBeenCalledWith(
          true,
          items.slice(2000).map((item) => externalItemKeyId(item.key)),
        );
        await act(async () =>
          renderer.root.findByProps({ 'aria-label': '회차 정렬' }).props.onChange({ target: { value: 'desc' } }),
        );
        expect(rows()[0]).toBe('2005화 이야기');
        expect(rows()).toHaveLength(10);
        await act(async () =>
          renderer.root.findByProps({ 'aria-label': '회차 검색' }).props.onChange({ target: { value: '1999화' } }),
        );
        expect(rows()).toEqual(['1999화 이야기']);
        expect(renderer.root.findByProps({ 'aria-label': '다음 페이지' }).props.disabled).toBe(true);
      } finally {
        await act(async () => renderer.unmount());
      }
    },
  );

  it('starts at chapter one even when a later chapter is current and preserves hidden selection counts', async () => {
    const items = releases(125).map((item, index) => ({
      ...item,
      selected: index === 114,
      readingState: index === 114 ? ('current' as const) : ('unread' as const),
    }));
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<SourceReleasePanel controller={control()} items={items} renderItem={renderItem} />);
    });
    expect(renderer.root.findByProps({ 'aria-label': '1페이지' }).props['aria-current']).toBe('page');
    expect(
      renderer.root.findByProps({ className: 'source-release-selection-summary' }).findByType('span').children.join(''),
    ).toContain('전체 1화 선택 · 이 페이지 0화');
    await act(async () => renderer.unmount());
  });

  it('does not drive network paging from renders and keeps cached rows selectable during background checks', async () => {
    const loadMore = vi.fn(async () => undefined);
    let view = control({ loadMore, catalogLoading: true });
    const items = releases(10);
    let renderer!: ReactTestRenderer;
    const update = async () =>
      act(async () => {
        renderer.update(<SourceReleasePanel controller={view} items={items} renderItem={renderItem} />);
      });
    await act(async () => {
      renderer = create(<SourceReleasePanel controller={view} items={items} renderItem={renderItem} />);
    });
    try {
      await update();
      expect(loadMore).not.toHaveBeenCalled();
      expect(renderer.root.findByProps({ type: 'checkbox' }).props.disabled).toBe(false);
      const apply = vi.fn();
      view = { ...view, catalogLoading: false, catalogUpdateAvailable: true, applyCatalogUpdate: apply };
      await update();
      expect(renderer.root.findAllByType('article')[0]!.children[0]).toBe('1화 이야기');
      const button = renderer.root.findAllByType('button').find((entry) => entry.children.includes('새 목차 적용'))!;
      await act(async () => button.props.onClick());
      expect(apply).toHaveBeenCalledOnce();
      expect(loadMore).not.toHaveBeenCalled();
    } finally {
      await act(async () => renderer.unmount());
    }
  });
});
