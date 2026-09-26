import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReaderPersonalizationRepository } from '../../repositories/reader-personalization-repository';
import { ReaderUserFontManager } from './ReaderUserFontManager';

let renderer: ReactTestRenderer;
afterEach(async () => {
  await act(async () => renderer?.unmount());
});
it('distinguishes a storage failure from an invalid font and leaves the current selection alone', async () => {
  const repository: ReaderPersonalizationRepository = {
    listUserFonts: vi.fn().mockResolvedValue([]),
    getUserFontContent: vi.fn(),
    installUserFont: vi.fn().mockRejectedValue(new Error('storage_unavailable')),
    updateUserFont: vi.fn(),
    deleteUserFont: vi.fn(),
    appendReadingSession: vi.fn(),
    listReadingSessions: vi.fn(),
    deleteReadingSessions: vi.fn(),
  };
  const selectFont = vi.fn();
  await act(async () => {
    renderer = create(
      <ReaderUserFontManager repository={repository} activeFontId="builtin-serif" selectFont={selectFont} />,
    );
  });
  const upload = async (file: File) => {
    await act(async () => renderer.root.findByType('input').props.onChange({ target: { files: [file] } }));
  };
  await upload(new File(['not a font'], 'invalid.ttf'));
  expect(JSON.stringify(renderer.toJSON())).toContain('유효한 WOFF2, WOFF, TTF 또는 OTF');
  expect(repository.installUserFont).not.toHaveBeenCalled();
  // Real browser font decoding is covered by user-font-csp.test.mjs.
  await upload(new File([new Uint8Array([0, 1, 0, 0])], 'valid-header.ttf'));
  expect(repository.installUserFont).toHaveBeenCalledOnce();
  expect(JSON.stringify(renderer.toJSON())).toContain('서버 연결과 저장 공간');
  expect(JSON.stringify(renderer.toJSON())).not.toContain('유효한 WOFF2');
  expect(selectFont).not.toHaveBeenCalled();
});
