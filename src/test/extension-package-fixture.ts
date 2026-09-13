/** Synthetic example; no private source, endpoints or credentials. */
export const examplePackageManifest = () => ({
  packageFormat: 'moya.extension.package',
  packageVersion: 1,
  extension: {
    manifestVersion: 1,
    id: 'org.example.catalog',
    name: '예제 소스',
    version: '1.0.0',
    engine: { moyaApi: 1 },
    permissions: ['external.source.list', 'external.source.download'],
    contributes: {
      externalSources: [
        {
          schemaVersion: 2,
          id: 'org.example.catalog.source',
          title: '예제',
          kind: 'catalog',
          runtimes: ['tauri-native', 'self-host-gateway'],
          capabilities: ['browse', 'release-list', 'release-download', 'document-content'],
          seriesProfile: { kind: 'document_series', format: 'txt', encoding: 'utf-8', chapterSplitMode: 'single' },
        },
      ],
    },
  },
  execution: { kind: 'moya-js', apiVersion: 1, entry: 'dist/main.js' },
  requestedAccess: { networkOrigins: ['https://catalog.example'], storageKiB: 0 },
  license: 'MIT',
});
