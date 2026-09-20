import {
  normalizeDiscoveryConfig,
  type DiscoveryConfig,
  type DiscoveryTab,
} from '../../integration-settings/discovery-settings';
export type { DiscoveryConfig, DiscoveryTab, DiscoverySection } from '../../integration-settings/discovery-settings';

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
export function readStoredConfig(scope: string): DiscoveryConfig | undefined {
  try {
    return normalizeDiscoveryConfig(JSON.parse(localStorage.getItem(configKey(scope)) ?? 'null'));
  } catch {
    return;
  }
}
export function readConfig(scope: string): DiscoveryConfig {
  return readStoredConfig(scope) ?? emptyConfig();
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

export function pinnedSource(tab: DiscoveryTab): string | undefined {
  return tab.sections.length === 1 && tab.sections[0]?.sourceId === tab.pinnedSourceId ? tab.pinnedSourceId : undefined;
}
export function togglePinnedSource(config: DiscoveryConfig, sourceId: string, title: string): DiscoveryConfig {
  if (config.tabs.some((tab) => pinnedSource(tab) === sourceId)) {
    return { ...config, tabs: config.tabs.filter((tab) => pinnedSource(tab) !== sourceId) };
  }
  if (config.tabs.length >= 30) throw new Error('탭은 최대 30개까지 추가할 수 있습니다.');
  return {
    ...config,
    tabs: [
      ...config.tabs,
      {
        ...newTab(title),
        pinnedSourceId: sourceId,
        sections: [{ id: crypto.randomUUID(), sourceId, title: '', mode: 'popular' }],
      },
    ],
  };
}
