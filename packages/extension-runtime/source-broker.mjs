import { createHash, randomUUID } from 'node:crypto';
import { createSourceHttp } from './source-http.mjs';
import {
  MAX_SOURCE_ASSET_BYTES,
  MAX_SOURCE_CONTENT_BYTES,
  MAX_SOURCE_IMAGES,
  MAX_SOURCE_TEXT_BYTES,
} from './content-limits.mjs';

const MAX_ASSET_BYTES = MAX_SOURCE_ASSET_BYTES;
const MAX_SESSION_BYTES = MAX_SOURCE_CONTENT_BYTES;

/** Assets are host-owned and scoped to this invocation, never filesystem paths or cross-package references. */
export function createSourceBroker({ origins, allowDownloads = false }, transportOptions) {
  const http = createSourceHttp(origins, transportOptions);
  const assets = new Map();
  const lifetime = new AbortController();
  let allocated = 0;
  let disposed = false;
  const own = (bytes, contentType) => {
    if (disposed || assets.size >= MAX_SOURCE_IMAGES) throw new Error('source_asset_limit');
    const handle = randomUUID();
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    assets.set(handle, { bytes, contentType });
    return { handle, byteLength: bytes.length, sha256, contentType };
  };
  return {
    methods: {
      'http.request': async (input, signal) => {
        if (disposed || (input?.response === 'asset' && !allowDownloads)) throw new Error('permission_denied');
        const response = await http(input, AbortSignal.any([signal, lifetime.signal]));
        const limit = input.response === 'asset' ? MAX_ASSET_BYTES : MAX_SOURCE_TEXT_BYTES;
        const declared = response.headers['content-length'];
        let held = 0;
        const abort = () => response.body.destroy(new Error('cancelled'));
        response.signal.addEventListener('abort', abort, { once: true });
        try {
          response.signal.throwIfAborted();
          if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > limit))
            throw new Error('source_body_limit');
          const chunks = [];
          for await (const chunk of response.body) {
            response.signal.throwIfAborted();
            if (disposed || held + chunk.length > limit || allocated + chunk.length > MAX_SESSION_BYTES)
              throw new Error('source_body_limit');
            held += chunk.length;
            allocated += chunk.length;
            chunks.push(Buffer.from(chunk));
          }
          response.signal.throwIfAborted();
          const bytes = Buffer.concat(chunks, held);
          if (!bytes.length) throw new Error('source_empty_body');
          if (input.response === 'text') return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
          const type =
            typeof response.headers['content-type'] === 'string'
              ? response.headers['content-type'].split(';')[0].trim().slice(0, 128)
              : 'application/octet-stream';
          const asset = own(bytes, type);
          held = 0; // Allocation ownership transfers from this request to the asset registry.
          return asset;
        } finally {
          allocated -= held;
          response.signal.removeEventListener('abort', abort);
          response.body.destroy();
        }
      },
      'asset.fromText': async (input, signal) => {
        signal.throwIfAborted();
        if (!allowDownloads || disposed || typeof input?.text !== 'string') throw new Error('permission_denied');
        const bytes = Buffer.from(input.text, 'utf8');
        if (!bytes.length || bytes.length > MAX_SOURCE_TEXT_BYTES || allocated + bytes.length > MAX_SESSION_BYTES)
          throw new Error('source_body_limit');
        const asset = own(bytes, 'text/plain');
        allocated += bytes.length;
        return asset;
      },
    },
    takeAsset(handle) {
      if (disposed || !assets.has(handle)) throw new Error('source_asset_unavailable');
      const asset = assets.get(handle);
      assets.delete(handle);
      allocated -= asset.bytes.length;
      return asset;
    },
    dispose() {
      disposed = true;
      lifetime.abort();
      assets.clear();
    },
  };
}
