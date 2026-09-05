import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { LibraryViewMode } from './library-screen-model';

interface VirtualizedLibraryCollectionProps {
  readonly count: number;
  readonly viewMode: LibraryViewMode;
  readonly resetKey: string;
  itemKey(index: number): string;
  renderItem(index: number): ReactNode;
}

/** Window rows, rather than individual cards, so CSS keeps ownership of the responsive grid. */
export function VirtualizedLibraryCollection({
  count,
  viewMode,
  resetKey,
  itemKey,
  renderItem,
}: VirtualizedLibraryCollectionProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState({ columns: 1, gap: 0, margin: 0, estimate: 340 });
  const [focusedItem, setFocusedItem] = useState<number>();
  const focusedControl = useRef(0);
  const focusedRow = focusedItem === undefined ? undefined : Math.floor(focusedItem / layout.columns);
  const className = viewMode === 'grid' ? 'books-grid' : 'books-list';
  const getScrollElement = useCallback(() => rootRef.current?.closest<HTMLElement>('.library-main') ?? null, []);
  const rowCount = Math.ceil(count / layout.columns);
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement,
    estimateSize: () => (viewMode === 'list' ? 80 : layout.estimate),
    getItemKey: (row) => itemKey(row * layout.columns),
    scrollMargin: layout.margin,
    gap: layout.gap,
    overscan: 3,
    initialRect: { width: 800, height: 800 },
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range);
      if (focusedRow !== undefined && focusedRow < rowCount) {
        for (const row of [focusedRow - 1, focusedRow, focusedRow + 1]) {
          if (row >= 0 && row < rowCount && !indexes.includes(row)) indexes.push(row);
        }
        indexes.sort((left, right) => left - right);
      }
      return indexes;
    },
  });

  useLayoutEffect(() => {
    const root = rootRef.current;
    const scrollElement = getScrollElement();
    if (!root || !scrollElement) return;
    const measure = () => {
      const style = getComputedStyle(root);
      const tracks = style.gridTemplateColumns.split(' ').filter(Boolean);
      const columns = viewMode === 'grid' ? Math.max(1, tracks.length) : 1;
      const gap = viewMode === 'grid' ? Number.parseFloat(style.rowGap) || 0 : 0;
      const margin =
        root.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top + scrollElement.scrollTop;
      const cardWidth = Number.parseFloat(tracks[0]) || 200;
      const estimate = cardWidth * 1.5 + 110;
      setLayout((previous) =>
        previous.columns === columns &&
        previous.gap === gap &&
        previous.margin === margin &&
        previous.estimate === estimate
          ? previous
          : { columns, gap, margin, estimate },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    observer.observe(scrollElement);
    // Changes above the collection (the recent book band and controls) can move its scroll origin.
    for (const child of scrollElement.children) if (child !== root) observer.observe(child);
    return () => observer.disconnect();
  }, [getScrollElement, viewMode]);

  useEffect(() => {
    virtualizer.measure();
  }, [layout.columns, layout.estimate, viewMode, virtualizer]);

  useLayoutEffect(() => {
    const scrollElement = getScrollElement();
    // A filtered result can leave virtual mode entirely; its first row should still be visible.
    return () => {
      if (scrollElement) scrollElement.scrollTop = 0;
    };
  }, [getScrollElement]);

  const previousColumns = useRef(layout.columns);
  useLayoutEffect(() => {
    if (previousColumns.current === layout.columns) return;
    previousColumns.current = layout.columns;
    if (focusedItem === undefined) return;
    const item = rootRef.current?.querySelector(`[data-library-item="${focusedItem}"]`);
    const controls = item?.querySelectorAll<HTMLElement>('button, a, input, select');
    controls?.[focusedControl.current]?.focus({ preventScroll: true });
  }, [focusedItem, layout.columns]);

  const previousResetKey = useRef(resetKey);
  useLayoutEffect(() => {
    if (previousResetKey.current === resetKey) return;
    previousResetKey.current = resetKey;
    setFocusedItem(undefined);
    const scrollElement = getScrollElement();
    if (scrollElement) scrollElement.scrollTop = 0;
  }, [getScrollElement, resetKey]);

  return (
    <div
      ref={rootRef}
      className={`${className} library-virtual-collection`}
      role="list"
      aria-label="작품 목록"
      style={{ height: virtualizer.getTotalSize() }}
      onFocusCapture={(event) => {
        const target = event.target as HTMLElement;
        const item = target.closest<HTMLElement>('[data-library-item]');
        if (!item) return;
        focusedControl.current = [...item.querySelectorAll('button, a, input, select')].indexOf(target);
        setFocusedItem(Number(item.dataset.libraryItem));
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusedItem(undefined);
      }}
    >
      {virtualizer.getVirtualItems().map((row) => (
        <div
          key={row.key}
          ref={virtualizer.measureElement}
          data-index={row.index}
          className={`${className} library-virtual-row`}
          role="presentation"
          style={{ transform: `translateY(${row.start - layout.margin}px)` }}
        >
          {Array.from({ length: Math.min(layout.columns, count - row.index * layout.columns) }, (_, column) => {
            const index = row.index * layout.columns + column;
            return (
              <div key={itemKey(index)} data-library-item={index} style={{ display: 'contents' }} role="presentation">
                {renderItem(index)}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
