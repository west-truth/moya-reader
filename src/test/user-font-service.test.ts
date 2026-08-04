import { describe, expect, it } from 'vitest';
import { prepareUserFont } from '../features/reader-settings/user-font-service';

describe('user font validation', () => {
  it('accepts a signature-matching WOFF2 file and creates deterministic metadata', async () => {
    const file = new File([new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0])], 'My_Font.woff2', {
      type: 'font/woff2',
    });
    const first = await prepareUserFont(file);
    const second = await prepareUserFont(file);
    expect(first.asset).toMatchObject({ familyLabel: 'My Font', contentType: 'font/woff2', byteLength: 8 });
    expect(first.asset.id).toBe(second.asset.id);
  });

  it('rejects extension and signature mismatches', async () => {
    const file = new File([new Uint8Array([0x77, 0x4f, 0x46, 0x32])], 'wrong.ttf');
    await expect(prepareUserFont(file)).rejects.toThrow('font_extension_mismatch');
  });
});
