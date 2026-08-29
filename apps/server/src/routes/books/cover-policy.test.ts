import { describe, expect, it } from 'vitest';
import { generatedCoverCanReplace, isWritableCoverProvenance } from './cover-routes.js';

describe('hosted generated cover policy', () => {
  it('replaces only another generated preview', () => {
    expect(generatedCoverCanReplace('generated_preview')).toBe(true);
    expect(generatedCoverCanReplace('user_supplied')).toBe(false);
    expect(generatedCoverCanReplace('epub_embedded')).toBe(false);
    expect(generatedCoverCanReplace('archive_embedded')).toBe(false);
  });

  it('preserves the host-approved enrichment provenance across cover transport', () => {
    expect(isWritableCoverProvenance('user_supplied')).toBe(true);
    expect(isWritableCoverProvenance('approved_enrichment')).toBe(true);
    expect(isWritableCoverProvenance('generated_preview')).toBe(true);
    expect(isWritableCoverProvenance('epub_embedded')).toBe(false);
  });
});
