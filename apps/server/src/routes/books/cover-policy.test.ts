import { describe, expect, it } from 'vitest';
import {
  coverContentRevisionConflict,
  generatedCoverCanReplace,
  isWritableCoverProvenance,
} from './cover-routes.js';

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

  it('accepts tokenless legacy cover writes only before a book id has been purged and reused', () => {
    expect(
      coverContentRevisionConflict(
        { active_content_revision_id: 'revision-1', has_prior_purge: false },
        undefined,
      ),
    ).toBeUndefined();
    expect(
      coverContentRevisionConflict(
        { active_content_revision_id: 'revision-2', has_prior_purge: true },
        undefined,
      ),
    ).toBe('content_revision_required');
  });

  it('rejects a stale cover command from an older content incarnation', () => {
    const book = { active_content_revision_id: 'revision-2', has_prior_purge: true };
    expect(coverContentRevisionConflict(book, 'revision-1')).toBe('content_revision_changed');
    expect(coverContentRevisionConflict(book, 'revision-2')).toBeUndefined();
  });
});
