import type { ExternalSourceContributionDescriptor } from '@noveldesk/extension-contracts';
import type { BuiltInExternalSourceDefinition } from './app-external-source-registry';

export const GOOGLE_DRIVE_EXTERNAL_SOURCE_ID = 'moya.external.google-drive.files' as const;
export const GOOGLE_DRIVE_EXTERNAL_SOURCE_BROKER_ID = 'google-drive' as const;

export const GOOGLE_DRIVE_EXTERNAL_SOURCE_DESCRIPTOR = {
  id: GOOGLE_DRIVE_EXTERNAL_SOURCE_ID,
  schemaVersion: 1,
  title: 'Google Drive',
  description: 'Google Picker에서 직접 선택한 지원 파일만 라이브러리에 연결합니다.',
  kind: 'cloud_file',
  capabilities: ['browse', 'search', 'file-download'],
  runtimes: ['web-direct'],
  order: 20,
} as const satisfies ExternalSourceContributionDescriptor;

export const googleDriveBuiltInExternalSource: BuiltInExternalSourceDefinition = {
  descriptor: GOOGLE_DRIVE_EXTERNAL_SOURCE_DESCRIPTOR,
  brokerId: GOOGLE_DRIVE_EXTERNAL_SOURCE_BROKER_ID,
};
