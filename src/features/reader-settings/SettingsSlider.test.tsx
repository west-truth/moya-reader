import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { SettingsSlider } from './SettingsSlider';

it('restores a blank input and keeps the slider exposed to assistive technology', () => {
  const change = vi.fn();
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<SettingsSlider label="글자 크기" value={18} min={11} max={40} step={1} onChange={change} />);
  });
  const input = renderer.root.findByType('input');
  act(() => input.props.onChange({ target: { value: '' } }));
  act(() => input.props.onBlur({ currentTarget: { value: '' } }));
  expect(change).not.toHaveBeenCalled();
  expect(input.props.value).toBe('18');
  const slider = renderer.root.findByProps({ role: 'slider' });
  expect(slider.parent?.props['aria-hidden']).toBeUndefined();
  act(() => input.props.onBlur({ currentTarget: { value: '99' } }));
  expect(change).toHaveBeenCalledWith(40);
  act(() => renderer.unmount());
});

it('cancels vertical intent and lost pointer capture without persisting the draft', () => {
  const change = vi.fn();
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<SettingsSlider label="간격" value={10} min={0} max={30} step={1} onChange={change} />, {
      createNodeMock: (element) => (element.type === 'div' ? { clientWidth: 100 } : null),
    });
  });
  const slider = renderer.root.findByProps({ role: 'slider' });
  const event = {
    isPrimary: true,
    pointerType: 'mouse',
    button: 0,
    pointerId: 1,
    clientX: 0,
    clientY: 0,
    currentTarget: { setPointerCapture: vi.fn(), hasPointerCapture: () => false },
    preventDefault: vi.fn(),
  };
  act(() => slider.props.onPointerDown(event));
  act(() => slider.props.onPointerMove({ ...event, clientX: 1, clientY: 20 }));
  act(() => slider.props.onPointerMove({ ...event, clientX: 100, clientY: 20 }));
  act(() => slider.props.onPointerUp(event));
  expect(change).not.toHaveBeenCalled();
  act(() => slider.props.onPointerDown(event));
  act(() => slider.props.onLostPointerCapture(event));
  act(() => slider.props.onPointerUp(event));
  expect(change).not.toHaveBeenCalled();
  act(() => renderer.unmount());
});
