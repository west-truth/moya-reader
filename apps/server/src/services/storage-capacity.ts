import { statfs } from 'node:fs/promises';
import type { StorageCapacity } from '@noveldesk/contracts';
import type { ServerConfig } from '../config.js';

/** Only an operator-declared path, or the explicitly mounted bundled MinIO volume, is trusted. */
export function storageCapacityPath(config: ServerConfig): string | undefined {
  if (config.storageCapacityPath) return config.storageCapacityPath;
  // An explicit empty string disables the bundled-volume probe.
  if (config.storageCapacityPath === '') return undefined;
  if (config.objectStorageDir) return config.objectStorageDir;
  try {
    if (new URL(config.s3.endpoint).hostname === 'minio') return '/data/storage-capacity';
  } catch {
    /* No local capacity can be inferred for this endpoint. */
  }
  return undefined;
}

export async function readStorageCapacity(config: ServerConfig): Promise<StorageCapacity> {
  const directory = storageCapacityPath(config);
  if (!directory) return { status: 'unavailable', reason: 'not_configured' };
  try {
    const info = await statfs(directory, { bigint: true });
    const totalBytes = Number(info.blocks * info.bsize);
    const availableBytes = Math.min(totalBytes, Number(info.bavail * info.bsize));
    if (
      !Number.isSafeInteger(totalBytes) ||
      totalBytes <= 0 ||
      !Number.isSafeInteger(availableBytes) ||
      availableBytes < 0
    )
      return { status: 'unavailable', reason: 'read_failed' };
    return {
      status: 'available',
      totalBytes,
      availableBytes,
      minimumFreeBytes: config.storageMinimumFreeBytes ?? 256 * 1024 ** 2,
    };
  } catch {
    return { status: 'unavailable', reason: 'read_failed' };
  }
}

export class StorageSpaceError extends Error {
  readonly statusCode = 507;
  constructor(message = '서버 저장공간이 부족합니다. 공간을 확보한 뒤 다시 시도해 주세요.') {
    super(message);
    this.name = 'StorageSpaceError';
  }
}

/** Advisory per-write check. Other processes/services can consume space after the check. */
export async function assertObjectStorageSpace(config: ServerConfig, requiredBytes: number): Promise<void> {
  if (!storageCapacityPath(config)) return;
  const capacity = await readStorageCapacity(config);
  if (capacity.status !== 'available')
    throw new StorageSpaceError('저장소의 남은 공간을 확인하지 못했습니다. 서버 저장소 연결을 확인해 주세요.');
  if (
    !Number.isSafeInteger(requiredBytes) ||
    requiredBytes < 0 ||
    requiredBytes > capacity.availableBytes - capacity.minimumFreeBytes
  )
    throw new StorageSpaceError();
}
