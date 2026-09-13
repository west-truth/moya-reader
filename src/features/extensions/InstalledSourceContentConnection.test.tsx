import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { InstalledExtensionManager } from '../../extensions/packages/installed-extension-manager';
import { InstalledSourceContentConnection } from './InstalledSourceContentConnection';

it('keeps existing server-managed connections usable without credential inputs', async () => {
  const contentConnection = vi.fn(async () => ({ configured: true, managed: true }));
  const manager = { target: 'server', contentConnection } as unknown as InstalledExtensionManager;
  const renderer = create(
    <InstalledSourceContentConnection manager={manager} sourceId="org.example.source" disabled={false} />,
  );
  await act(async () => {});
  expect(renderer.root.findAllByType('input')).toHaveLength(0);
  expect(renderer.root.findByType('details').props.open).toBeUndefined();
  expect(contentConnection).toHaveBeenCalledTimes(1);
  act(() => renderer.unmount());
});
it('saves a keyless connection with optional credentials folded away', async () => {
  const contentConnection = vi.fn(async () => ({ configured: false }));
  const manager = { target: 'device', contentConnection } as unknown as InstalledExtensionManager;
  const renderer = create(
    <InstalledSourceContentConnection manager={manager} sourceId="org.example.source" disabled={false} />,
  );
  await act(async () => {});
  expect(renderer.root.findByProps({ type: 'password' }).props.required).toBeUndefined();
  expect(renderer.root.findAllByType('details').every((node) => !node.props.open)).toBe(true);
  act(() => renderer.root.findByProps({ type: 'url' }).props.onChange({ target: { value: 'http://localhost:9870' } }));
  await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  expect(contentConnection.mock.calls.at(-1)).toEqual([
    'org.example.source',
    { action: 'save', endpoint: 'http://localhost:9870' },
  ]);
  act(() => renderer.unmount());
});
