import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { NovelpiaAuthSettings } from './NovelpiaAuthSettings';

describe('NovelpiaAuthSettings', () => {
  it('submits credentials and LOGINKEY through separate mobile-friendly forms', async () => {
    const connectCredentials = vi.fn(async () => false);
    const connectLoginKey = vi.fn(async () => false);
    const renderer = create(
      <NovelpiaAuthSettings
        enabled={false}
        credentialsRemembered={false}
        busy={false}
        disabled={false}
        connectCredentials={connectCredentials}
        connectLoginKey={connectLoginKey}
        enableSaved={vi.fn(async () => true)}
        disable={vi.fn(async () => true)}
      />,
    );

    act(() => renderer.root.findByProps({ 'aria-expanded': false }).props.onClick());
    const email = renderer.root.findByProps({ type: 'email' });
    const password = renderer.root.findByProps({ autoComplete: 'current-password' });
    act(() => {
      email.props.onChange({ target: { value: 'reader@example.com' } });
      password.props.onChange({ target: { value: 'private-password' } });
    });
    await act(async () => {
      renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
      await Promise.resolve();
    });
    expect(connectCredentials).toHaveBeenCalledWith('reader@example.com', 'private-password');

    act(() => renderer.root.findAllByProps({ role: 'tab' })[1]!.props.onClick());
    const loginKey = 'a'.repeat(32) + '_' + 'b'.repeat(32);
    act(() => renderer.root.findByProps({ autoComplete: 'off' }).props.onChange({ target: { value: loginKey } }));
    await act(async () => {
      renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
      await Promise.resolve();
    });
    expect(connectLoginKey).toHaveBeenCalledWith(loginKey);
  });
});
