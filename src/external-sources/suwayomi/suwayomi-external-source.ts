import type { ExternalSourceContributionDescriptor } from '@noveldesk/extension-contracts';
import type { BuiltInExternalSourceDefinition } from '../app-external-source-registry';

export const SUWAYOMI_EXTERNAL_SOURCE_ID = 'moya.external.suwayomi.sources' as const;
export const SUWAYOMI_EXTERNAL_SOURCE_BROKER_ID = 'suwayomi' as const;

export const SUWAYOMI_EXTERNAL_SOURCE_DESCRIPTOR = {
  id: SUWAYOMI_EXTERNAL_SOURCE_ID,
  schemaVersion: 1,
  title: 'Suwayomi / Mihon 소스',
  description: '사용자 소유 Suwayomi Server에 설치된 Mihon 호환 소스를 탐색하고 회차를 가져옵니다.',
  kind: 'catalog',
  capabilities: ['browse', 'search', 'work-details', 'release-list', 'cover-read', 'file-download'],
  runtimes: ['web-direct', 'self-host-gateway'],
  order: 30,
} as const satisfies ExternalSourceContributionDescriptor;

export const suwayomiBuiltInExternalSource: BuiltInExternalSourceDefinition = {
  descriptor: SUWAYOMI_EXTERNAL_SOURCE_DESCRIPTOR,
  brokerId: SUWAYOMI_EXTERNAL_SOURCE_BROKER_ID,
};
