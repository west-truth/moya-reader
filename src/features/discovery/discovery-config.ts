import type { ExternalSourceFilterChange } from '../../external-sources/contracts';

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
export const newTab = (title = '새 탭'): DiscoveryTab => ({
  id: crypto.randomUUID(),
  title,
  hidden: false,
  density: 'comfortable',
  sections: [],
});
export const emptyConfig = (): DiscoveryConfig => ({
  version: 1,
  tabs: [newTab('만화'), newTab('소설'), newTab('웹툰')],
});
export function configKey(scope: string) {
  return `moya.discovery.v1:${scope}`;
}
export function readConfig(scope: string): DiscoveryConfig {
  try {
    const v = JSON.parse(localStorage.getItem(configKey(scope)) ?? 'null') as DiscoveryConfig;
    if (
      v?.version === 1 &&
      Array.isArray(v.tabs) &&
      v.tabs.length <= 30 &&
      v.tabs.every(
        (t) =>
          typeof t.id === 'string' &&
          typeof t.title === 'string' &&
          typeof t.hidden === 'boolean' &&
          ['comfortable', 'compact'].includes(t.density) &&
          Array.isArray(t.sections) &&
          t.sections.length <= 60 &&
          t.sections.every(
            (s) =>
              typeof s.id === 'string' &&
              typeof s.sourceId === 'string' &&
              typeof s.title === 'string' &&
              ['popular', 'latest'].includes(s.mode),
          ),
      )
    )
      return v;
  } catch {
    /* Storage unavailable or old invalid configuration. */
  }
  return emptyConfig();
}
export function writeConfig(scope: string, config: DiscoveryConfig) {
  localStorage.setItem(configKey(scope), JSON.stringify(config));
}
export function move<T>(items: readonly T[], index: number, offset: number): T[] {
  const next = [...items];
  const to = index + offset;
  if (to < 0 || to >= next.length) return next;
  const [entry] = next.splice(index, 1);
  next.splice(to, 0, entry!);
  return next;
}
