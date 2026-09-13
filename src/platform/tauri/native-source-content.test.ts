import { describe, expect, it } from 'vitest';
import { decodeNativeAssets } from './native-package-execution';
import { validateSourceResult } from '@noveldesk/extension-contracts/source-protocol';
import { MAX_SOURCE_ASSET_BYTES, MAX_SOURCE_IMAGES } from '../../../packages/extension-runtime/content-limits.mjs';

function response(assets: { handle: string; type: string; size: number }[], body: Uint8Array[], tail = false) {
  const result = {
    kind: 'images',
    assets: assets.map((a) => ({ handle: a.handle, byteLength: a.size, contentType: a.type, sha256: 'a'.repeat(64) })),
  };
  const metadata = new TextEncoder().encode(JSON.stringify({ assets, result }));
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, metadata.length);
  // Split both length and JSON framing, including across transport reads.
  const parts = [prefix.slice(0, 1), prefix.slice(1), metadata.slice(0, 13), metadata.slice(13), ...body];
  if (tail) parts.push(new Uint8Array([1]));
  let index = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (index < parts.length) controller.enqueue(parts[index++]);
        else controller.close();
      },
    }),
  );
}

describe('native large chapter transfer', () => {
  it('accepts over 256 images and over 32 MiB without flattening the response', async () => {
    const data = new Uint8Array(128 * 1024).fill(7);
    const rows = Array.from({ length: 300 }, (_, i) => ({ handle: String(i), type: 'image/jpeg', size: data.length }));
    const decoded = await decodeNativeAssets(
      response(
        rows,
        rows.map(() => data),
      ),
    );
    expect(validateSourceResult('source.getContent', decoded.result)).toBe(true);
    expect(decoded.assets.size).toBe(300);
    expect([...decoded.assets.values()].reduce((n, a) => n + a.size, 0)).toBe(37.5 * 1024 * 1024);
    expect(new Uint8Array(await decoded.assets.get('299')!.arrayBuffer())).toEqual(data);
  });
  it('rejects excessive counts and individual assets before consuming their body', async () => {
    await expect(
      decodeNativeAssets(
        response(
          Array.from({ length: MAX_SOURCE_IMAGES + 1 }, (_, i) => ({ handle: String(i), type: 'image/jpeg', size: 1 })),
          [],
        ),
      ),
    ).rejects.toThrow('invalid_native_response');
    await expect(
      decodeNativeAssets(response([{ handle: 'a', type: 'image/jpeg', size: MAX_SOURCE_ASSET_BYTES + 1 }], [])),
    ).rejects.toThrow('invalid_native_response');
  });
  it('still rejects truncation, duplicate handles and trailing bytes', async () => {
    const asset = { handle: 'a', type: 'image/jpeg', size: 4 };
    await expect(decodeNativeAssets(response([asset], [new Uint8Array(3)]))).rejects.toThrow('invalid_native_response');
    await expect(decodeNativeAssets(response([asset, asset], [new Uint8Array(8)]))).rejects.toThrow(
      'invalid_native_response',
    );
    await expect(decodeNativeAssets(response([asset], [new Uint8Array(4)], true))).rejects.toThrow(
      'invalid_native_response',
    );
  });
});
