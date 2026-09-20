import type { ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { DiscoveryEditor } from './DiscoveryEditor';
import { newTab } from './discovery-config';

vi.mock('../../shared/ui/ModalDrawer', () => ({
  ModalDrawer: ({ children, footer }: { children: ReactNode; footer: ReactNode }) => (
    <div>
      {children}
      {footer}
    </div>
  ),
}));

it('keeps the draft and original base on failed asynchronous saves, then closes only after confirmation', async () => {
  const config = { version: 1 as const, tabs: [newTab('내 탭')] };
  let finish!: () => void;
  let reject!: (error: Error) => void;
  const save = vi.fn(
    () =>
      new Promise<void>((resolve, fail) => {
        finish = resolve;
        reject = fail;
      }),
  );
  const close = vi.fn();
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<DiscoveryEditor config={config} sources={[]} save={save} close={close} />);
  });
  const button = () =>
    renderer.root.findAllByType('button').find((node) => ['저장', '저장 중…'].includes(node.props.children))!;
  let pending!: Promise<void>;
  await act(async () => {
    pending = button().props.onClick();
  });
  expect(button().props.disabled).toBe(true);
  expect(close).not.toHaveBeenCalled();
  await act(async () => {
    reject(new Error('연결 실패'));
    await pending;
  });
  expect(renderer.root.findByProps({ role: 'alert' }).children).toEqual(['연결 실패']);
  expect(close).not.toHaveBeenCalled();
  await act(async () => {
    pending = button().props.onClick();
  });
  expect(save).toHaveBeenLastCalledWith(config, config);
  await act(async () => {
    finish();
    await pending;
  });
  expect(close).toHaveBeenCalledTimes(1);
  await act(async () => renderer.unmount());
});
