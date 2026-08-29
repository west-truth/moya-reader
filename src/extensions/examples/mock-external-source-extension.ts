import {
  MOYA_EXTENSION_API_VERSION,
  MOYA_EXTENSION_MANIFEST_VERSION,
  MOYA_EXTERNAL_SOURCE_SCHEMA_VERSION,
  type ExtensionManifestV1,
} from '@noveldesk/extension-contracts';
import type { TrustedAnalysisWorkflowHostContext } from '../analysis-workflow-host-context';
import type { TrustedReaderAddonHostContext } from '../reader-addon-host-context';
import type { TrustedExtensionDefinition } from '../trusted-extension-registry';

export const MOCK_EXTERNAL_SOURCE_EXTENSION_ID = 'moya.dev.external-fixture' as const;
export const MOCK_EXTERNAL_SOURCE_ID = 'moya.dev.external-fixture.catalog' as const;

const manifest = {
  manifestVersion: MOYA_EXTENSION_MANIFEST_VERSION,
  id: MOCK_EXTERNAL_SOURCE_EXTENSION_ID,
  name: '개발용 외부 소스',
  version: '1.0.0',
  engine: { moyaApi: MOYA_EXTENSION_API_VERSION },
  permissions: ['external.source.list', 'external.source.download'],
  contributes: {
    externalSources: [
      {
        id: MOCK_EXTERNAL_SOURCE_ID,
        schemaVersion: MOYA_EXTERNAL_SOURCE_SCHEMA_VERSION,
        title: '개발용 작품 목록',
        description: '외부 소스 UI와 revision 변경 재가져오기를 확인하기 위한 개발 fixture입니다.',
        kind: 'catalog',
        capabilities: ['browse', 'search', 'work-import'],
        runtimes: ['web-direct'],
        order: 900,
      },
    ],
  },
} as const satisfies ExtensionManifestV1;

const baseSamples = [
  {
    id: 'fixture-work-1',
    title: '은하 철도의 밤',
    author: '미야자와 겐지',
    updatedAt: '2026-08-20T12:00:00.000Z',
    content:
      '# 제1화 별빛 정거장\n\n조용한 밤, 열차가 은하수를 따라 달렸다.\n\n# 제2화 먼 여행\n\n창밖의 별들이 천천히 뒤로 흘렀다.',
  },
  {
    id: 'fixture-work-2',
    title: '바람이 머무는 서재',
    author: 'Moya fixture',
    updatedAt: '2026-08-21T08:30:00.000Z',
    content: '# 프롤로그\n\n오래 닫혀 있던 서재의 문이 열렸다.\n\n# 첫 번째 기록\n\n책장 사이로 작은 바람이 불었다.',
  },
] as const;

function fixtureRevision(): number {
  const parsed = Number(import.meta.env.VITE_EXTERNAL_SOURCE_FIXTURE_REVISION ?? '1');
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

function samples() {
  const revision = fixtureRevision();
  return baseSamples.map((sample, index) => ({
    ...sample,
    updatedAt:
      revision === 1
        ? sample.updatedAt
        : new Date(Date.parse(sample.updatedAt) + (revision - 1) * 24 * 60 * 60 * 1_000).toISOString(),
    content:
      revision === 1
        ? sample.content
        : `${sample.content}\n\n# fixture revision ${revision}\n\n원격 원문 변경을 확인하기 위한 개발용 문단 ${index + 1}.`,
    remoteRevision: `fixture-${sample.id}-r${revision}`,
  }));
}

/** Explicit development fixture. It is dynamically imported only when the smoke flag is enabled. */
export const mockExternalSourceTrustedExtension: TrustedExtensionDefinition<
  TrustedReaderAddonHostContext,
  TrustedAnalysisWorkflowHostContext
> = {
  manifest,
  activate(context) {
    return context.externalSources.register(MOCK_EXTERNAL_SOURCE_ID, {
      status: () => ({
        state: 'connected',
        accountConnectionId: 'fixture-account',
        label: '개발 fixture',
      }),
      connect: async () => undefined,
      disconnect: async () => undefined,
      list: async (_hostContext, input, signal) => {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const query = input.query?.trim().toLocaleLowerCase();
        const currentSamples = samples();
        const filtered = query
          ? currentSamples.filter(
              (sample) =>
                sample.title.toLocaleLowerCase().includes(query) || sample.author.toLocaleLowerCase().includes(query),
            )
          : currentSamples;
        return {
          items: filtered.map((sample) => ({
            key: {
              connectorId: MOCK_EXTERNAL_SOURCE_ID,
              accountConnectionId: input.accountConnectionId ?? 'fixture-account',
              remoteId: sample.id,
            },
            kind: 'work' as const,
            title: sample.title,
            importFileName: `${sample.title}.txt`,
            subtitle: sample.author,
            author: sample.author,
            mimeType: 'text/plain',
            formatHint: 'txt',
            byteLength: new TextEncoder().encode(sample.content).byteLength,
            remoteRevision: sample.remoteRevision,
            updatedAt: sample.updatedAt,
            importability: 'supported' as const,
          })),
        };
      },
      download: async (_hostContext, ref, signal) => {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const sample = samples().find((candidate) => candidate.id === ref.key.remoteId);
        if (!sample) throw new Error('개발 fixture 작품을 찾을 수 없습니다.');
        return {
          file: new File([sample.content], `${sample.title}.txt`, {
            type: 'text/plain',
            lastModified: Date.parse(sample.updatedAt),
          }),
          remoteRevision: sample.remoteRevision,
        };
      },
    });
  },
};
