import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { TaskProgressRing } from './TaskProgressRing';

it('opens details when the progress ring is clicked and leaves cancel separate', () => {
  const open = vi.fn();
  const cancel = vi.fn();
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <>
        <TaskProgressRing percent={63} label="받는 중" onOpen={open} />
        <button type="button" onClick={cancel}>
          중단
        </button>
      </>,
    );
  });
  const detailButton = renderer.root
    .findAllByType('button')
    .find((button) => button.props['aria-label'] === '받는 중 상세 보기');
  act(() => detailButton!.props.onClick());
  expect(open).toHaveBeenCalledOnce();
  expect(cancel).not.toHaveBeenCalled();
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
