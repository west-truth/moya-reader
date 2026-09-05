import type { ExternalSourceContributionDescriptorV2 } from '@noveldesk/extension-contracts';
import type { BuiltInExternalSourceDefinition } from '../app-external-source-registry';

export const TEXT_SERVER_EXTERNAL_SOURCE_ID = 'moya.external.text-server.sources' as const;
export const TEXT_SERVER_EXTERNAL_SOURCE_BROKER_ID = 'text-server' as const;
export const TEXT_SERVER_PROFILE = {
  kind: 'document_series',
  format: 'txt',
  encoding: 'utf-8',
  chapterSplitMode: 'single',
} as const;
export const TEXT_SERVER_EXTERNAL_SOURCE_DESCRIPTOR: ExternalSourceContributionDescriptorV2 = {
  id: TEXT_SERVER_EXTERNAL_SOURCE_ID,
  schemaVersion: 2,
  title: '텍스트 소스 서버',
  description: '별도 텍스트 서버의 작품과 목차를 탐색하고 선택한 TXT 회차를 가져옵니다.',
  kind: 'catalog',
  capabilities: [
    'browse',
    'search',
    'work-details',
    'release-list',
    'release-download',
    'document-content',
    'subscriptions',
    'cover-read',
  ],
  runtimes: ['web-direct', 'self-host-gateway'],
  seriesProfile: TEXT_SERVER_PROFILE,
  order: 40,
};
export const textServerBuiltInExternalSource: BuiltInExternalSourceDefinition = {
  descriptor: TEXT_SERVER_EXTERNAL_SOURCE_DESCRIPTOR,
  brokerId: TEXT_SERVER_EXTERNAL_SOURCE_BROKER_ID,
};
