import { describe, expect, it, vi } from 'vitest';
import { NativeApkCatalog } from './native-apk-catalog';
import { packageSha256 } from './package-archive';

describe('native APK transport', () => {
  it('validates image bytes and rejects a result from a replaced installation', async () => {
    const blob = new Blob([new Uint8Array([255, 216, 255, 217])], { type: 'image/jpeg' });
    const asset = {
      handle: 'image',
      byteLength: blob.size,
      contentType: blob.type,
      sha256: await packageSha256(new Uint8Array(await blob.arrayBuffer())),
    };
    let generation = 'one';
    const request = vi.fn(async () => ({
      available: true,
      sources: [{ packageId: 'org.example.apk', generation, descriptor: { id: 'org.example.source' } }],
    }));
    const invoke = vi.fn(async () => ({ result: asset, assets: new Map([['image', blob]]) }));
    const catalog = new NativeApkCatalog({ request, invoke }, async () => {});
    await catalog.refresh();
    expect(
      (
        await catalog.invoke('org.example.source', 'source.getCover', { workId: 'one' }, new AbortController().signal)
      ).assets.get('image'),
    ).toBe(blob);
    invoke.mockImplementationOnce(async () => {
      generation = 'two';
      await catalog.refresh();
      return { result: asset, assets: new Map([['image', blob]]) };
    });
    await expect(
      catalog.invoke('org.example.source', 'source.getCover', { workId: 'one' }, new AbortController().signal),
    ).rejects.toThrow('package_generation_changed');
    invoke.mockResolvedValueOnce({ result: { ...asset, sha256: '0'.repeat(64) }, assets: new Map([['image', blob]]) });
    await expect(
      catalog.invoke('org.example.source', 'source.getCover', { workId: 'one' }, new AbortController().signal),
    ).rejects.toThrow('invalid_source_assets');
    catalog.dispose();
  });
});
