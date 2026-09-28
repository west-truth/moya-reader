import { create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../../repositories/reader-defaults';
import { SourceAdvancedSettings } from './SourceAdvancedSettings';

describe('SourceAdvancedSettings', () => {
  it('counts source works against the source by default and switches to downloaded chapters on request', () => {
    const updateSettings = vi.fn();
    const renderer = create(<SourceAdvancedSettings controller={{ settings: defaultSettings, updateSettings }} />);
    const toggle = renderer.root.findByType('input');

    expect(toggle.props.checked).toBe(false);
    toggle.props.onChange({ target: { checked: true } });
    expect(updateSettings).toHaveBeenLastCalledWith({ sourceProgressBasis: 'downloaded' });

    renderer.update(
      <SourceAdvancedSettings
        controller={{ settings: { ...defaultSettings, sourceProgressBasis: 'downloaded' }, updateSettings }}
      />,
    );
    expect(renderer.root.findByType('input').props.checked).toBe(true);
    renderer.root.findByType('input').props.onChange({ target: { checked: false } });
    expect(updateSettings).toHaveBeenLastCalledWith({ sourceProgressBasis: 'source' });
  });
});
