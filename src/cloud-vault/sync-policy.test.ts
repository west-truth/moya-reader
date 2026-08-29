import { describe, expect, it } from 'vitest';
import { DEFAULT_CLOUD_VAULT_SCOPE } from './contracts';
import { cloudVaultMutationDelay, cloudVaultMutationEnabled } from './sync-policy';

describe('Cloud Vault sync policy', () => {
  it('does not schedule statistics alone and bounds progress deferral', () => {
    expect(cloudVaultMutationDelay(new Set(['statistics']), 0)).toBeUndefined();
    expect(cloudVaultMutationDelay(new Set(['progress']), 0)).toBe(60_000);
    expect(cloudVaultMutationDelay(new Set(['progress']), 179_000)).toBe(1_000);
  });

  it('prioritizes explicit durable changes', () => {
    expect(cloudVaultMutationDelay(new Set(['progress', 'annotations']), 0)).toBe(5_000);
  });

  it('ignores disabled domains', () => {
    expect(cloudVaultMutationEnabled('annotations', { ...DEFAULT_CLOUD_VAULT_SCOPE, annotations: false })).toBe(false);
    expect(cloudVaultMutationEnabled('aiTts', { ...DEFAULT_CLOUD_VAULT_SCOPE, aiTtsArtifacts: false })).toBe(false);
    expect(cloudVaultMutationEnabled('progress', DEFAULT_CLOUD_VAULT_SCOPE)).toBe(true);
  });
});
