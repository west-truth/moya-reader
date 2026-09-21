import { MAX_SOURCE_IMAGES } from '../../../../packages/extension-runtime/content-limits.mjs';

/** Selected by the host operation, never by extension-supplied WebView arguments. */
export function sourceBrowserLimits(purpose?: 'image-pages') {
  return {
    // Wire traffic includes navigation, scripts, TLS and repeated image requests.
    bytes: (purpose === 'image-pages' ? 512 : 32) * 1024 * 1024,
    requests: 512 + (purpose === 'image-pages' ? MAX_SOURCE_IMAGES : 0),
  };
}
