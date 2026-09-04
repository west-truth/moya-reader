import { describe, expect, it } from 'vitest';
import {
  mergeInitialSelfHostIntegrationSettings,
  normalizeSelfHostIntegrationSettings,
} from './self-host-integration-settings';

const now = '2026-09-04T00:00:00.000Z';

function validDocument() {
  return {
    schemaVersion: 1,
    revision: 4,
    updatedAt: now,
    legacyImportCompleted: true,
    extensionEnablement: {
      schemaVersion: 1,
      enabledByExtensionId: { 'moya.extension.metadata': true },
    },
    webNovelMetadata: {
      schemaVersion: 1,
      includeAdult: false,
      automaticLookup: true,
      automaticApply: 'missing_fields',
    },
    externalSources: {
      schemaVersion: 1,
      connections: [
        {
          schemaVersion: 1,
          connectorId: 'moya.external.suwayomi.sources',
          accountConnectionId: 'suwayomi:abc',
          endpoint: 'https://suwayomi.example.test',
          authMode: 'none',
          label: 'Suwayomi',
          updatedAt: now,
        },
      ],
      links: [
        {
          id: 'external-link::chapter:1',
          source: {
            connectorId: 'moya.external.suwayomi.sources',
            accountConnectionId: 'suwayomi:abc',
            remoteId: 'chapter:1',
          },
          localBookId: 'book-1',
          collectionRemoteId: 'manga:1',
          linkedAt: now,
        },
      ],
      subscriptions: [
        {
          id: 'external-source-subscription::manga:1',
          connectorId: 'moya.external.suwayomi.sources',
          accountConnectionId: 'suwayomi:abc',
          collectionRemoteId: 'manga:1',
          navigationRef: 'manga:1',
          title: '작품',
          knownReleaseIds: ['chapter:1'],
          newReleaseIds: [],
          availableReleaseCount: 1,
          lastCheckedAt: now,
          createdAt: now,
          updatedAt: now,
          schemaVersion: 1,
        },
      ],
    },
  };
}

describe('self-host integration settings contract', () => {
  it('keeps non-secret extension and source library state', () => {
    expect(normalizeSelfHostIntegrationSettings(validDocument())).toEqual(validDocument());
  });

  it('rejects credential-bearing URLs and in-flight source intents', () => {
    const credentialUrl = validDocument();
    credentialUrl.externalSources.connections[0]!.endpoint = 'https://user:secret@suwayomi.example.test';
    expect(normalizeSelfHostIntegrationSettings(credentialUrl)).toBeUndefined();

    const pending = validDocument();
    Object.assign(pending.externalSources.links[0]!, {
      pendingImport: {
        operationId: 'operation-1',
        stagedAt: now,
        hadExistingLink: false,
        expectedActiveSourceContentHash: 'sha256:pending',
      },
    });
    expect(normalizeSelfHostIntegrationSettings(pending)).toBeUndefined();
  });

  it('merges an upgraded device cache without overriding established server choices', () => {
    const base = normalizeSelfHostIntegrationSettings(validDocument())!;
    const remote = {
      ...base,
      webNovelMetadata: { ...base.webNovelMetadata, automaticLookup: false, automaticApply: 'off' as const },
      externalSources: { schemaVersion: 1 as const, connections: [], links: [], subscriptions: [] },
    };
    const local = {
      ...base,
      extensionEnablement: {
        schemaVersion: 1 as const,
        enabledByExtensionId: {
          ...base.extensionEnablement.enabledByExtensionId,
          'moya.extension.local-only': false,
        },
      },
    };

    const merged = mergeInitialSelfHostIntegrationSettings(remote, local);

    expect(merged.externalSources).toEqual(local.externalSources);
    expect(merged.legacyImportCompleted).toBe(true);
    expect(merged.webNovelMetadata).toEqual(local.webNovelMetadata);
    expect(merged.extensionEnablement.enabledByExtensionId).toEqual({
      'moya.extension.local-only': false,
      'moya.extension.metadata': true,
    });
  });

  it('treats an established pre-marker server document as already migrated', () => {
    const { legacyImportCompleted: _completed, revision: _revision, ...legacy } = validDocument();

    expect(normalizeSelfHostIntegrationSettings(legacy)?.legacyImportCompleted).toBe(true);
    expect(normalizeSelfHostIntegrationSettings(legacy)?.revision).toBe(0);

    expect(
      normalizeSelfHostIntegrationSettings({
        ...legacy,
        extensionEnablement: { schemaVersion: 1, enabledByExtensionId: {} },
        webNovelMetadata: {
          schemaVersion: 1,
          includeAdult: false,
          automaticLookup: false,
          automaticApply: 'off',
        },
        externalSources: { schemaVersion: 1, connections: [], links: [], subscriptions: [] },
      })?.legacyImportCompleted,
    ).toBe(true);
  });
});
