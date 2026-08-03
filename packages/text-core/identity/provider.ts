import { persistentId128 } from '../id-hash-contract';
import { structuredIntegrityHash } from './structured-integrity';

export function providerSettingsId(userId: string, scope: string): string {
  return persistentId128('provider_settings', [userId, scope]);
}

export function providerSecretId(input: {
  userId: string;
  scope: string;
  providerId: string;
  secretName: string;
}): string {
  return persistentId128('provider_secret', [input.userId, input.scope, input.providerId, input.secretName]);
}

export function providerOptionsIntegrityHash(options: unknown): string {
  return structuredIntegrityHash(options);
}

export function providerRequestIntegrityHash(value: unknown): string {
  return structuredIntegrityHash(value);
}

export function providerSourceContextIntegrityHash(value: unknown): string {
  return structuredIntegrityHash(value);
}

export function providerDiscoveredGraphIntegrityHash(value: unknown): string {
  return structuredIntegrityHash(value);
}

export function providerJobId(input: {
  userId: string;
  novelId: string;
  chapterId?: string;
  jobType: string;
  providerId: string;
  modelId?: string;
  inputHash: string;
}): string {
  return persistentId128('provider_job', [
    input.userId,
    input.novelId,
    input.chapterId ?? '',
    input.jobType,
    input.providerId,
    input.modelId ?? '',
    input.inputHash,
  ]);
}
