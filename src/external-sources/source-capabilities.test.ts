import { describe, expect, it } from 'vitest';
import type {
  ExternalSourceContributionDescriptor,
  ExternalSourceContributionDescriptorV2,
} from '@noveldesk/extension-contracts';
import { supportsExternalSourceLibrary } from './source-capabilities';

const descriptor = (
  overrides: Partial<ExternalSourceContributionDescriptorV2> = {},
): ExternalSourceContributionDescriptorV2 => ({
  id: 'fixture.source',
  schemaVersion: 2,
  title: 'Fixture',
  kind: 'catalog',
  capabilities: ['browse', 'work-details', 'release-list', 'release-download', 'document-content'],
  runtimes: ['self-host-gateway'],
  seriesProfile: {
    kind: 'document_series',
    format: 'txt',
    encoding: 'utf-8',
    chapterSplitMode: 'single',
  },
  ...overrides,
});

describe('supportsExternalSourceLibrary', () => {
  it('keeps the explicit legacy subscription capability working', () => {
    const legacy: ExternalSourceContributionDescriptor = {
      id: 'fixture.legacy',
      schemaVersion: 1,
      title: 'Legacy',
      kind: 'catalog',
      capabilities: ['browse', 'subscriptions'],
      runtimes: ['web-direct'],
    };
    expect(supportsExternalSourceLibrary(legacy)).toBe(true);
  });

  it('recognizes complete document and image series contracts without a duplicate marker', () => {
    expect(supportsExternalSourceLibrary(descriptor())).toBe(true);
    expect(
      supportsExternalSourceLibrary(
        descriptor({
          capabilities: ['browse', 'work-details', 'release-list', 'release-download', 'image-content'],
          seriesProfile: { kind: 'image_series', archiveFormat: 'cbz' },
        }),
      ),
    ).toBe(true);
  });

  it('does not offer library tracking when required serial operations are absent', () => {
    expect(
      supportsExternalSourceLibrary(
        descriptor({ capabilities: ['browse', 'work-details', 'release-list', 'document-content'] }),
      ),
    ).toBe(false);
    expect(
      supportsExternalSourceLibrary(
        descriptor({ capabilities: ['browse', 'release-list', 'release-download', 'document-content'] }),
      ),
    ).toBe(false);
  });
});
