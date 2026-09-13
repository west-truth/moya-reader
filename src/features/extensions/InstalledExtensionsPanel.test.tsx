import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { InstalledExtensionsPanel } from './InstalledExtensionsPanel';
import type { InstalledExtensionManager, PackageReview } from '../../extensions/packages/installed-extension-manager';

it('finishes repository installation and publisher acknowledgement inside the chosen entry', async () => {
  const file = new File(['fixture'], 'source.moyaext');
  const plan = {
    operation: 'install',
    publisherChanged: true,
    downgrade: false,
    package: {
      manifest: {
        extension: { id: 'org.fixture', name: 'Example Source', version: '1.0.0', permissions: [] },
        requestedAccess: { networkOrigins: [], storageKiB: 0 },
      },
    },
  } as unknown as PackageReview;
  const snapshot = { available: true, packages: [], sources: [], errors: [], revision: 1 };
  const install = vi.fn(async () => {});
  const manager = {
    target: 'server',
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    install,
    listRepositories: async () => [
      {
        url: 'https://example.com/index.json',
        revision: 1,
        index: {
          format: 'moya.extension.repository',
          version: 1,
          packages: [
            {
              id: 'org.fixture',
              name: 'Example Source',
              version: '1.0.0',
              sha256: 'a'.repeat(64),
              archive: 'source.moyaext',
            },
          ],
        },
      },
    ],
    selectRepositoryPackage: async () => ({ file, plan }),
  } as unknown as InstalledExtensionManager;
  const renderer = create(<InstalledExtensionsPanel manager={manager} />);
  const button = (label: string) =>
    renderer.root.findAllByType('button').find((node) => node.props.children === label)!;
  await act(async () => button('저장소').props.onClick());
  await act(async () => button('설치').props.onClick());
  const row = renderer.root
    .findAllByType('article')
    .find((node) => node.findAllByType('strong').some((title) => title.props.children === 'Example Source'))!;
  const confirmation = row.findByProps({ 'aria-label': '확장 설치 확인' });
  expect(button('설치').props.disabled).toBe(true);
  await act(async () => confirmation.findByProps({ type: 'checkbox' }).props.onChange({ target: { checked: true } }));
  expect(button('설치').props.disabled).toBe(false);
  await act(async () => button('설치').props.onClick());
  expect(install).toHaveBeenCalledWith(file, plan);
  expect(renderer.root.findAllByProps({ 'aria-label': '확장 설치 확인' })).toHaveLength(0);
  act(() => renderer.unmount());
});
