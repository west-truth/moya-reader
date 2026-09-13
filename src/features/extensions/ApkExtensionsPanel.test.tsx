import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { ApkExtensionsPanel } from './ApkExtensionsPanel';
import type { ApkExtensionManager, ApkInstallReview } from '../../extensions/packages/apk-extension-manager';
const review = (id = 'plan'): ApkInstallReview => ({
  id,
  revision: 1,
  pkg: 'org.fixture',
  version: '1',
  digest: 'digest',
  signers: [],
});
function fixture() {
  const manager: ApkExtensionManager = {
    list: vi.fn(async () => ({
      available: true,
      revision: 1,
      packages: [],
      repositories: [
        {
          url: 'https://repo.example/index.json',
          updatedAt: 0,
          entries: [
            {
              pkg: 'org.fixture',
              name: 'Fixture',
              version: '1',
              code: 1,
              apk: 'fixture.apk',
              lang: 'en',
              nsfw: false,
              sources: [],
              excludedSources: 0,
            },
          ],
        },
      ],
    })),
    refreshRepository: vi.fn(),
    removeRepository: vi.fn(),
    inspectRepository: vi.fn(async () => review()),
    discardReview: vi.fn(async () => {}),
    install: vi.fn(),
    change: vi.fn(),
  };
  return manager;
}
const button = (r: ReturnType<typeof create>, label: string) =>
  r.root.findAllByType('button').find((b) => b.props.children === label)!;
it('keeps trust and installation inside the selected catalog card', async () => {
  const manager = fixture();
  const r = create(<ApkExtensionsPanel manager={manager} format="mangayomi-js" />);
  await act(async () => {});
  await act(async () => button(r, '설치').props.onClick());
  const card = r.root
    .findAllByType('article')
    .find((node) => node.findAllByType('strong').some((title) => title.props.children === 'Fixture'))!;
  const confirmation = card.findByProps({ 'aria-label': 'Mangayomi JS 설치 확인' });
  const install = () => confirmation.findAllByType('button').find((node) => node.props.children === '설치')!;
  expect(install().props.disabled).toBe(true);
  await act(async () => confirmation.findByProps({ type: 'checkbox' }).props.onChange({ target: { checked: true } }));
  expect(install().props.disabled).toBe(false);
  await act(async () => install().props.onClick());
  expect(manager.install).toHaveBeenCalledWith(review(), expect.any(AbortSignal));
  expect(r.root.findAllByProps({ 'aria-label': 'Mangayomi JS 설치 확인' })).toHaveLength(0);
  act(() => r.unmount());
});
it('discards repeated cancelled reviews and releases the last review when leaving the panel', async () => {
  const manager = fixture();
  const r = create(<ApkExtensionsPanel manager={manager} format="mangayomi-js" />);
  await act(async () => {});
  for (let i = 0; i < 6; i++) {
    await act(async () => button(r, '설치').props.onClick());
    expect(button(r, '설치').props.disabled).toBe(true);
    expect(button(r, '취소').props.disabled).toBe(false);
    await act(async () => button(r, '취소').props.onClick());
  }
  expect(manager.discardReview).toHaveBeenCalledTimes(6);
  await act(async () => button(r, '설치').props.onClick());
  act(() => r.unmount());
  expect(manager.discardReview).toHaveBeenCalledTimes(7);
  expect(manager.install).not.toHaveBeenCalled();
  // Inspection is read-only: no post-inspection inventory request holds the review UI busy.
  expect(manager.list).toHaveBeenCalledTimes(1);
});
it('cancels an outstanding inspection and ignores its late result after a new inspection', async () => {
  const manager = fixture();
  let finish!: (v: ApkInstallReview) => void;
  let oldSignal!: AbortSignal;
  vi.mocked(manager.inspectRepository).mockImplementationOnce(async (_url, _pkg, _code, signal) => {
    oldSignal = signal!;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const r = create(<ApkExtensionsPanel manager={manager} />);
  await act(async () => {});
  act(() => button(r, '설치').props.onClick());
  act(() => button(r, '준비 취소').props.onClick());
  expect(oldSignal.aborted).toBe(true);
  await act(async () => button(r, '설치').props.onClick());
  await act(async () => finish(review('old')));
  expect(manager.discardReview).toHaveBeenCalledWith('old');
  expect(button(r, '설치').props.disabled).toBe(true);
  expect(button(r, '취소').props.disabled).toBe(false);
  act(() => r.unmount());
  expect(manager.discardReview).toHaveBeenCalledWith('plan');
});

it('reviews direct files with source selection and discards abandoned plans', async () => {
  const manager = fixture();
  manager.inspectFile = vi.fn(async (_file, _signal, sourceIndex = 0) => ({
    ...review('file-' + sourceIndex),
    sourceIndex,
    fileSources: [
      { name: 'First', lang: 'en' },
      { name: 'Second', lang: 'ko' },
    ],
  }));
  const r = create(<ApkExtensionsPanel manager={manager} format="mangayomi-js" />);
  await act(async () => {});
  const file = new File(['source'], 'extension.js');
  await act(async () =>
    r.root.findByProps({ type: 'file' }).props.onChange({ currentTarget: { files: [file], value: 'extension.js' } }),
  );
  expect(manager.inspectFile).toHaveBeenCalledWith(file, expect.any(AbortSignal));
  await act(async () =>
    r.root.findByProps({ 'aria-label': '파일의 소스 선택' }).props.onChange({ target: { value: '1' } }),
  );
  expect(manager.discardReview).toHaveBeenCalledWith('file-0');
  expect(manager.inspectFile).toHaveBeenLastCalledWith(file, expect.any(AbortSignal), 1);
  expect(button(r, '설치').props.disabled).toBe(true);
  act(() => r.unmount());
  expect(manager.discardReview).toHaveBeenCalledWith('file-1');
});
