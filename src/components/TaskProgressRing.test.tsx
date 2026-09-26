import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { TaskProgressRing } from './TaskProgressRing';

it('shows the measured percentage inside the existing cancel action without a details button', () => {
  const cancel = vi.fn();
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <button aria-label="다운로드 중단" onClick={cancel}>
        <TaskProgressRing percent={63} label="다운로드 중" />
      </button>,
    );
  });
  expect(renderer.root.findAllByType('button')).toHaveLength(1);
  act(() => renderer.root.findByType('button').props.onClick());
  expect(cancel).toHaveBeenCalledOnce();
  expect(renderer.root.findByProps({ role: 'progressbar' }).props['aria-valuenow']).toBe(63);
  expect(renderer.root.findByProps({ className: 'task-progress-ring-value' }).children.join('')).toBe('63%');
  act(() => renderer.unmount());
});

it('has no numeric value when the total is unknown', () => {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<TaskProgressRing label="준비 중" />);
  });
  expect(renderer.root.findByProps({ role: 'progressbar' }).props['aria-valuenow']).toBeUndefined();
  act(() => renderer.unmount());
});
