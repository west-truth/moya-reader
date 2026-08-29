import { describe, expect, it } from 'vitest';
import { cloudVaultErrorMessage } from './useCloudVaultController';

describe('Cloud Vault error boundary', () => {
  it('preserves sanitized Tauri string errors', () => {
    expect(cloudVaultErrorMessage('Dropbox token request failed (HTTP 400).')).toBe(
      'Dropbox token request failed (HTTP 400).',
    );
  });

  it('preserves object-shaped native errors', () => {
    expect(cloudVaultErrorMessage({ message: 'native credential could not be saved' })).toBe(
      'native credential could not be saved',
    );
  });

  it('keeps the generic fallback for unknown values', () => {
    expect(cloudVaultErrorMessage(undefined)).toBe('Cloud Vault 작업을 완료하지 못했습니다.');
  });
});
