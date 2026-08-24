import type { ExternalSourceContributionDescriptor } from '@noveldesk/extension-contracts';
import type { BuiltInExternalSourceDefinition } from './app-external-source-registry';

// Keep the established connector ID so existing encrypted credentials, cache pages and book links remain valid.
export const DROPBOX_EXTERNAL_SOURCE_ID = 'moya.external.dropbox.files' as const;
export const DROPBOX_EXTERNAL_SOURCE_BROKER_ID = 'dropbox' as const;

export const DROPBOX_EXTERNAL_SOURCE_DESCRIPTOR = {
  id: DROPBOX_EXTERNAL_SOURCE_ID,
  schemaVersion: 1,
  title: 'Dropbox',
  description: 'Dropbox의 지원 파일을 목록에서 선택해 로컬 서재로 가져옵니다.',
  kind: 'cloud_file',
  capabilities: ['browse', 'search', 'file-download'],
  runtimes: ['web-direct'],
  order: 10,
} as const satisfies ExternalSourceContributionDescriptor;

export const dropboxBuiltInExternalSource: BuiltInExternalSourceDefinition = {
  descriptor: DROPBOX_EXTERNAL_SOURCE_DESCRIPTOR,
  brokerId: DROPBOX_EXTERNAL_SOURCE_BROKER_ID,
};
