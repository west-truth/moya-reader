import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { InstalledExtensionManager } from '../../extensions/packages/installed-extension-manager';
import { ExtensionUpdatesPanel } from './ExtensionUpdatesPanel';

it('queues compatibility reviews and inspects each after the previous confirmed install', async () => {
  let revision = 1;
  const inspectRepository = vi.fn(async (_url: string, pkg: string) => ({
    id: pkg,
    pkg,
    revision,
    digest: pkg,
    version: '2',
    signers: ['trusted'],
  }));
  const install = vi.fn(async (review: { revision: number }) => {
    expect(review.revision).toBe(revision);
    revision++;
    return {};
  });
  const compatibility = {
    list: async () => ({
      packages: ['a', 'b'].map((pkg) => ({ pkg, code: 1, version: '1' })),
      repositories: [
        {
          url: 'https://example.test/index.min.json',
          entries: ['a', 'b'].map((pkg) => ({ pkg, name: pkg, code: 2, version: '2' })),
        },
      ],
    }),
    refreshRepository: vi.fn(),
    inspectRepository,
    install,
  };
  const manager = { getSnapshot: () => ({ packages: [] }), apk: compatibility } as unknown as InstalledExtensionManager;
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<ExtensionUpdatesPanel manager={manager} />);
  });
  const click = async (text: string) => {
    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.join('') === text)!
        .props.onClick();
    });
  };
  await click('업데이트 확인');
  for (const input of renderer.root.findAllByType('input'))
    act(() => input.props.onChange({ target: { checked: true } }));
  await click('선택 2개 순서대로 검토');
  expect(inspectRepository).toHaveBeenCalledTimes(1);
  expect(install).not.toHaveBeenCalled();
  expect(
    renderer.root.findAllByType('button').find((b) => b.children.join('') === '확인한 업데이트 설치')!.props.disabled,
  ).toBe(true);
  act(() => renderer.root.findByType('input').props.onChange({ target: { checked: true } }));
  await click('확인한 업데이트 설치');
  expect(inspectRepository).toHaveBeenCalledTimes(2);
  expect(install).toHaveBeenCalledTimes(1);
  expect(renderer.root.findByType('input').props.checked).toBe(false);
  act(() => renderer.unmount());
});
