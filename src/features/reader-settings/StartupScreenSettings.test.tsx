import { create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { defaultSettings } from '../../repositories/reader-defaults';
import { StartupScreenSettings } from './StartupScreenSettings';

it('offers one selector for remembered, all, named shelves and visible discovery tabs', () => {
  const updateSettings = vi.fn();
  const renderer = create(
    <StartupScreenSettings
      controller={{ settings: defaultSettings, updateSettings }}
      shelves={[{ id: 'normal', name: 'Normal' }]}
      tabs={[
        { id: 'browse', title: '둘러보기' },
        { id: 'hidden', title: 'Hidden', hidden: true },
      ]}
    />,
  );
  const select = renderer.root.findByType('select');
  expect(select.props.value).toBe('last');
  expect(renderer.root.findAllByType('option').map((option) => option.props.value)).toEqual([
    'last',
    'library',
    'shelf:normal',
    'discovery',
    'tab:browse',
  ]);
  for (const [value, expected] of [
    ['shelf:normal', { kind: 'library', shelfId: 'normal' }],
    ['library', { kind: 'library' }],
    ['tab:browse', { kind: 'discovery', tabId: 'browse' }],
    ['last', undefined],
  ] as const) {
    select.props.onChange({ target: { value } });
    expect(updateSettings.mock.lastCall![0](defaultSettings).startupScreen).toEqual(expected);
  }
  renderer.unmount();
});
