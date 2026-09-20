import type { ExternalSourceFilterChange } from '../external-sources/contracts';

export interface DiscoverySection {
  id: string;
  sourceId: string;
  title: string;
  mode: 'popular' | 'latest';
  parentRef?: string;
  filters?: readonly ExternalSourceFilterChange[];
  filterSignature?: string;
}
export interface DiscoveryTab {
  pinnedSourceId?: string;
  id: string;
  title: string;
  hidden: boolean;
  density: 'comfortable' | 'compact';
  sections: DiscoverySection[];
}
export interface DiscoveryConfig {
  version: 1;
  tabs: DiscoveryTab[];
}
export interface DiscoverySettings {
  revision: number;
  updatedAt: string;
  config: DiscoveryConfig;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const text = (value: unknown, max = 1024): value is string => typeof value === 'string' && value.length <= max;
const position = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** Accept only portable layout/filter data, never transient queries or cached content. */
export function normalizeDiscoveryConfig(value: unknown): DiscoveryConfig | undefined {
  try {
    const root = record(value);
    if (root?.version !== 1 || !Array.isArray(root.tabs) || root.tabs.length > 30) return;
    const tabs: DiscoveryTab[] = [];
    for (const rawTab of root.tabs) {
      const tab = record(rawTab);
      if (
        !tab ||
        !text(tab.id) ||
        !tab.id ||
        !text(tab.title) ||
        typeof tab.hidden !== 'boolean' ||
        (tab.density !== 'comfortable' && tab.density !== 'compact') ||
        (tab.pinnedSourceId !== undefined && !text(tab.pinnedSourceId)) ||
        !Array.isArray(tab.sections) ||
        tab.sections.length > 60 ||
        tabs.some((t) => t.id === tab.id)
      )
        return;
      const sections: DiscoverySection[] = [];
      for (const rawSection of tab.sections) {
        const s = record(rawSection);
        if (
          !s ||
          !text(s.id) ||
          !s.id ||
          !text(s.sourceId) ||
          !s.sourceId ||
          !text(s.title) ||
          (s.mode !== 'popular' && s.mode !== 'latest') ||
          (s.parentRef !== undefined && !text(s.parentRef, 4096)) ||
          (s.filterSignature !== undefined && !text(s.filterSignature, 65536)) ||
          sections.some((section) => section.id === s.id)
        )
          return;
        let filters: ExternalSourceFilterChange[] | undefined;
        if (s.filters !== undefined) {
          if (!Array.isArray(s.filters) || s.filters.length > 256) return;
          filters = [];
          for (const rawFilter of s.filters) {
            const f = record(rawFilter);
            if (!f || !position(f.position) || (f.groupPosition !== undefined && !position(f.groupPosition))) return;
            const sort = record(f.value);
            let filterValue: ExternalSourceFilterChange['value'];
            if (
              typeof f.value === 'boolean' ||
              text(f.value, 4096) ||
              (typeof f.value === 'number' && Number.isFinite(f.value))
            ) {
              filterValue = f.value;
            } else if (
              sort &&
              Number.isSafeInteger(sort.index) &&
              (sort.index as number) >= -1 &&
              typeof sort.ascending === 'boolean'
            ) {
              filterValue = { index: sort.index as number, ascending: sort.ascending };
            } else return;
            filters.push({
              position: f.position,
              ...(f.groupPosition === undefined ? {} : { groupPosition: f.groupPosition }),
              value: filterValue,
            });
          }
        }
        sections.push({
          id: s.id,
          sourceId: s.sourceId,
          title: s.title,
          mode: s.mode,
          ...(s.parentRef === undefined ? {} : { parentRef: s.parentRef }),
          ...(s.filterSignature === undefined ? {} : { filterSignature: s.filterSignature }),
          ...(filters === undefined ? {} : { filters }),
        });
      }
      tabs.push({
        id: tab.id,
        title: tab.title,
        hidden: tab.hidden,
        density: tab.density,
        sections,
        ...(tab.pinnedSourceId === undefined ? {} : { pinnedSourceId: tab.pinnedSourceId }),
      });
    }
    const config: DiscoveryConfig = { version: 1, tabs };
    if (new TextEncoder().encode(JSON.stringify(config)).length > 512 * 1024) return;
    return config;
  } catch {
    return;
  }
}
