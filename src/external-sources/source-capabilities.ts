import type { ExternalSourceContributionDescriptor } from '@noveldesk/extension-contracts';

/**
 * Library tracking is a host feature. A v2 serial source already provides every
 * operation needed to save a work and refresh its releases, so package authors
 * should not need to repeat that fact with the legacy `subscriptions` marker.
 */
export function supportsExternalSourceLibrary(descriptor: ExternalSourceContributionDescriptor): boolean {
  if (descriptor.capabilities.includes('subscriptions')) return true;
  if (descriptor.schemaVersion !== 2 || descriptor.kind !== 'catalog' || !descriptor.seriesProfile) return false;
  const capabilities = new Set(descriptor.capabilities);
  if (!capabilities.has('work-details') || !capabilities.has('release-list') || !capabilities.has('release-download')) {
    return false;
  }
  return descriptor.seriesProfile.kind === 'document_series'
    ? capabilities.has('document-content')
    : capabilities.has('image-content');
}
