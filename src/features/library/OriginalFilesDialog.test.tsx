import type { ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import type { BookAssetRepository } from '../../repositories/book-asset-repository';
import { OriginalFilesDialog } from './OriginalFilesDialog';

vi.mock('../../shared/ui/Dialog', () => ({ Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
const book = { id: 'book-1', title: '합본' };
const file = {
  id: 'part-2',
  fileName: '2권.epub',
  byteLength: 2 * 1024 ** 3,
  contentType: 'application/epub+zip',
  contentHash: 'hash',
};
let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
async function render(repository: Partial<BookAssetRepository>, onLegacyExport = vi.fn()) {
  await act(async () => {
    renderer = create(
      <OriginalFilesDialog
        book={book}
        repository={repository as BookAssetRepository}
        onClose={() => undefined}
        onLegacyExport={onLegacyExport}
      />,
    );
  });
  return renderer!;
}

it('shows large originals and requests a native browser download without reading source blobs', async () => {
  const link = { href: '', download: '', target: '', rel: '', click: vi.fn(), remove: vi.fn() };
  vi.stubGlobal('document', { createElement: vi.fn(() => link), body: { append: vi.fn() } });
  const repository = {
    listOriginalFiles: vi.fn(async () => [file]),
    createOriginalFileDownload: vi.fn(async () => '/api/original-downloads/short-lived'),
    exportSource: vi.fn(),
  };
  const view = await render(repository);
  expect(JSON.stringify(view.toJSON())).toContain('2.00 GB');
  await act(async () => {
    view.root.findByProps({ 'aria-label': '2권.epub 다운로드' }).props.onClick();
  });
  expect(repository.createOriginalFileDownload).toHaveBeenCalledWith(book.id, file.id);
  expect(repository.exportSource).not.toHaveBeenCalled();
  expect(link.href).toBe('/api/original-downloads/short-lived');
  expect(link.click).toHaveBeenCalledOnce();
  expect(JSON.stringify(view.toJSON())).toContain('다운로드를 요청했습니다.');
});

it('keeps the dialog usable after list and ticket failures', async () => {
  const repository = {
    listOriginalFiles: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue([file]),
    createOriginalFileDownload: vi.fn().mockRejectedValue(new Error('offline')),
  };
  const view = await render(repository);
  expect(JSON.stringify(view.toJSON())).toContain('원본 목록을 불러오지 못했습니다.');
  await act(async () => {
    view.root.findAllByType('button')[0]!.props.onClick();
  });
  await act(async () => {
    view.root.findByProps({ 'aria-label': '2권.epub 다운로드' }).props.onClick();
  });
  expect(JSON.stringify(view.toJSON())).toContain('다운로드를 시작하지 못했습니다.');
  expect(view.root.findByProps({ 'aria-label': '2권.epub 다운로드' }).props.disabled).toBe(false);
});

it('does not start a delayed download after the dialog closes', async () => {
  let resolve!: (url: string) => void;
  const createElement = vi.fn();
  vi.stubGlobal('document', { createElement });
  const view = await render({
    listOriginalFiles: async () => [file],
    createOriginalFileDownload: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  await act(async () => {
    view.root.findByProps({ 'aria-label': '2권.epub 다운로드' }).props.onClick();
  });
  act(() => view.unmount());
  renderer = undefined;
  await act(async () => {
    resolve('/late');
  });
  expect(createElement).not.toHaveBeenCalled();
});

it('preserves reconstructed exports for internal source containers', async () => {
  const legacy = vi.fn();
  const view = await render({ listOriginalFiles: async () => null }, legacy);
  act(() => view.root.findAllByType('button')[0]!.props.onClick());
  expect(legacy).toHaveBeenCalledOnce();
});
