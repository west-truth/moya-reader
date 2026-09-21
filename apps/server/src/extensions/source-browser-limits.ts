import { MAX_SOURCE_CONTENT_BYTES, MAX_SOURCE_IMAGES } from '../../../../packages/extension-runtime/content-limits.mjs';

/** Selected by the host operation, never by extension-supplied WebView arguments. */
export function sourceBrowserLimits(purpose?: 'image-pages') {
  return {
    bytes: 32 * 1024 * 1024 + (purpose === 'image-pages' ? MAX_SOURCE_CONTENT_BYTES : 0),
    requests: 512 + (purpose === 'image-pages' ? MAX_SOURCE_IMAGES : 0),
  };
}
