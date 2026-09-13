import type { ExternalSourceProviderRegistryPort } from './app-external-source-registry';

/** First registered provider wins; installed packages cannot replace trusted connectors. */
export function compositeSourceRegistry(
  ...providers: readonly ExternalSourceProviderRegistryPort[]
): ExternalSourceProviderRegistryPort {
  const findOwner = (id: string) =>
    providers.find((provider) => provider.getExternalSources().some((source) => source.descriptor.id === id));
  const owner = (id: string) => {
    const provider = findOwner(id);
    if (!provider) throw new Error('external_source_unavailable');
    return provider;
  };
  return {
    getHostedImageImport: (id) => findOwner(id)?.getHostedImageImport?.(id),
    getHostedDocumentImport: (id) => findOwner(id)?.getHostedDocumentImport?.(id),
    getSourceExtensionManager: (id, ...args) => findOwner(id)?.getSourceExtensionManager?.(id, ...args),
    getExternalSources: () => {
      const seen = new Set<string>();
      return providers
        .flatMap((provider) => provider.getExternalSources())
        .filter((source) => {
          if (seen.has(source.descriptor.id)) return false;
          seen.add(source.descriptor.id);
          return true;
        });
    },
    // UI may still hold a source ID after disable/removal. Capability queries must remain safe during that render.
    getExternalSourceStatus: (id, ...args) =>
      findOwner(id)?.getExternalSourceStatus(id, ...args) ?? {
        state: 'unavailable',
        reason: '확장을 사용할 수 없습니다.',
      },
    getExternalSourceConnectionForm: (id, ...args) => findOwner(id)?.getExternalSourceConnectionForm?.(id, ...args),
    connectExternalSource: (id, ...args) => owner(id).connectExternalSource(id, ...args),
    disconnectExternalSource: (id, ...args) => owner(id).disconnectExternalSource(id, ...args),
    listExternalSource: (id, ...args) => owner(id).listExternalSource(id, ...args),
    downloadExternalSource: (id, ...args) => owner(id).downloadExternalSource(id, ...args),
    resolveExternalSourceCover: async (id, ...args) => owner(id).resolveExternalSourceCover?.(id, ...args),
    canPickExternalSource: (id, ...args) => findOwner(id)?.canPickExternalSource?.(id, ...args) ?? false,
    pickExternalSource: async (id, ...args) => {
      const provider = owner(id);
      if (!provider.pickExternalSource) throw new Error('external_source_picker_unavailable');
      return provider.pickExternalSource(id, ...args);
    },
    canRemoveExternalSourceItem: (id, ...args) => findOwner(id)?.canRemoveExternalSourceItem?.(id, ...args) ?? false,
    removeExternalSourceItem: async (id, ...args) => {
      const provider = owner(id);
      if (!provider.removeExternalSourceItem) throw new Error('external_source_remove_unavailable');
      return provider.removeExternalSourceItem(id, ...args);
    },
  };
}
