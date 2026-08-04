import { describe, expect, it } from 'vitest';
import { generatedCoverCanReplace } from './cover-routes.js';

describe('hosted generated cover policy', () => {
  it('replaces only another generated preview', () => {
    expect(generatedCoverCanReplace('generated_preview')).toBe(true);
    expect(generatedCoverCanReplace('user_supplied')).toBe(false);
    expect(generatedCoverCanReplace('epub_embedded')).toBe(false);
    expect(generatedCoverCanReplace('archive_embedded')).toBe(false);
  });
});
