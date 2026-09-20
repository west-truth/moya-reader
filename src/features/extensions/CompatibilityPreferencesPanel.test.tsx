import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { ApkExtensionManager } from '../../extensions/packages/apk-extension-manager';
import type { CompatibilityPreferences } from '../../extensions/packages/compatibility-preferences';
import { CompatibilityPreferencesPanel } from './CompatibilityPreferencesPanel';

describe('original extension preferences', () => {
  it('requires custom mode before editing a proxy and does not grant its origin to source code', async () => {
    const snapshot: CompatibilityPreferences = {
      revision: 1,
      privateOrigins: [],
      fields: [
        {
          key: '__moya_proxy_mode',
          title: '소스 연결 방식',
          kind: 'select',
          secret: false,
          value: 'inherit',
          choices: [
            { label: '기본값 사용', value: 'inherit' },
            { label: '개별 프록시', value: 'custom' },
          ],
        },
        { key: '__moya_outbound_proxy', title: '개별 프록시 주소', kind: 'text', secret: false, value: '' },
      ],
    };
    const savePreferences = vi.fn(async () => {});
    const manager = { preferences: async () => snapshot, savePreferences };
    const renderer = create(<CompatibilityPreferencesPanel pkg="source" manager={manager} onSaved={() => {}} />);
    await act(async () => {});
    expect(renderer.root.findByProps({ type: 'text' }).props.disabled).toBe(true);
    act(() => renderer.root.findByType('select').props.onChange({ target: { value: 'custom' } }));
    expect(renderer.root.findByProps({ type: 'text' }).props.disabled).toBeFalsy();
    act(() => renderer.root.findByProps({ type: 'text' }).props.onChange({ target: { value: 'http://proxy:8080' } }));
    await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
    expect(savePreferences).toHaveBeenCalledWith(
      'source',
      1,
      { __moya_proxy_mode: 'custom', __moya_outbound_proxy: 'http://proxy:8080' },
      [],
    );
    act(() => renderer.unmount());
  });
  it('groups APK sources, retains unchanged credentials and saves only edits without an extra password', async () => {
    const snapshot: CompatibilityPreferences = {
      revision: 4,
      networkPolicy: 'direct',
      privateOrigins: [],
      groups: [
        { id: '1', title: 'First' },
        { id: '2', title: 'Second' },
      ],
      fields: [
        { group: '1', key: '["1","key"]', title: 'Access key', secret: true, configured: true, kind: 'text' },
        { group: '1', key: '["1","url"]', title: 'Server URL', secret: false, kind: 'text', value: '' },
        { group: '2', key: '["2","enabled"]', title: 'Use server', secret: false, kind: 'boolean', value: false },
      ],
    };
    const savePreferences = vi.fn(async () => {});
    const manager = { preferences: vi.fn(async () => snapshot), savePreferences } as unknown as ApkExtensionManager;
    const onSaved = vi.fn();
    const renderer = create(
      <CompatibilityPreferencesPanel pkg="org.example.source" manager={manager} onSaved={onSaved} />,
    );
    await act(async () => {});
    expect(renderer.root.findAllByType('textarea')).toHaveLength(0);
    expect(renderer.root.findByProps({ type: 'password' }).props.value).toBe('');
    expect(renderer.root.findByProps({ type: 'password' }).props.placeholder).toContain('저장됨');
    expect(renderer.root.findByProps({ type: 'submit' }).props.disabled).toBe(true);
    act(() =>
      renderer.root.findByProps({ type: 'text' }).props.onChange({ target: { value: 'http://127.0.0.1:8080' } }),
    );
    act(() => renderer.root.findByType('select').props.onChange({ target: { value: '2' } }));
    expect(renderer.root.findAllByProps({ type: 'password' })).toHaveLength(0);
    act(() => renderer.root.findByProps({ type: 'checkbox' }).props.onChange({ target: { checked: true } }));
    await act(async () => {
      renderer.root.findByType('form').props.onSubmit({ preventDefault() {} });
    });
    expect(savePreferences).toHaveBeenCalledWith(
      'org.example.source',
      4,
      {
        '["1","url"]': 'http://127.0.0.1:8080',
        '["2","enabled"]': true,
      },
      [],
    );
    expect(onSaved).toHaveBeenCalledOnce();
    act(() => renderer.unmount());
  });
  it('keeps Mangayomi private-origin controls and original choices', async () => {
    const snapshot: CompatibilityPreferences = {
      revision: 1,
      privateOrigins: [],
      fields: [
        {
          key: 'mode',
          title: 'Mode',
          secret: false,
          kind: 'select',
          value: 1,
          choices: [
            { label: 'First', value: 1 },
            { label: 'Second', value: 2 },
          ],
        },
      ],
    };
    const savePreferences = vi.fn(async () => {});
    const manager = { preferences: async () => snapshot, savePreferences } as unknown as ApkExtensionManager;
    const renderer = create(
      <CompatibilityPreferencesPanel pkg="org.example.source" manager={manager} onSaved={() => {}} />,
    );
    await act(async () => {});
    act(() => renderer.root.findByType('select').props.onChange({ target: { value: '2' } }));
    act(() => renderer.root.findByType('textarea').props.onChange({ target: { value: 'http://127.0.0.1:8080' } }));
    await act(async () => {
      renderer.root.findByType('form').props.onSubmit({ preventDefault() {} });
    });
    expect(savePreferences).toHaveBeenCalledWith('org.example.source', 1, { mode: 2 }, ['http://127.0.0.1:8080']);
    act(() => renderer.unmount());
  });
});

it('saves and clears multiple original language choices without joining them into text', async () => {
  let snapshot: CompatibilityPreferences = {
    revision: 1,
    privateOrigins: [],
    fields: [
      {
        key: 'languages',
        title: 'Languages',
        kind: 'multi-select',
        secret: false,
        value: ['ko'],
        choices: [
          { label: 'Korean', value: 'ko' },
          { label: 'English', value: 'en' },
        ],
      },
    ],
  };
  const savePreferences = vi.fn(async (_pkg, _revision, changes) => {
    snapshot = {
      ...snapshot,
      revision: snapshot.revision + 1,
      fields: [{ ...snapshot.fields[0], value: changes.languages }],
    };
  });
  const manager = { preferences: async () => snapshot, savePreferences };
  const view = create(<CompatibilityPreferencesPanel pkg="test" manager={manager} onSaved={() => {}} />);
  await act(async () => {});
  expect(view.root.findByType('select').props.value).toEqual(['ko']);
  for (const values of [['ko', 'en'], []]) {
    act(() =>
      view.root
        .findByType('select')
        .props.onChange({ target: { selectedOptions: values.map((value) => ({ value })) } }),
    );
    await act(async () => {
      view.root.findByType('form').props.onSubmit({ preventDefault() {} });
    });
    expect(savePreferences.mock.calls.at(-1)?.[2]).toEqual({ languages: values });
    expect(view.root.findByType('select').props.value).toEqual(values);
  }
  act(() => view.unmount());
});
