import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { ExternalSourceSettingsPanel } from './ExternalSourceSettingsPanel';
import type { ExternalSourceController } from './useExternalSourceController';

afterEach(() => vi.unstubAllGlobals());
it('filters actual content/language metadata and persists favorites without guessing unknown metadata', () => {
  const setItem = vi.fn();
  vi.stubGlobal('localStorage', { getItem: () => null, setItem });
  const controller = {
    sources: [
      {
        id: 'text',
        title: '텍스트 소스',
        contentKind: 'text',
        lang: 'ko',
        origin: 'plugin',
        connection: { state: 'connected' },
      },
      {
        id: 'image',
        title: '만화 소스',
        contentKind: 'image',
        lang: 'all',
        origin: 'plugin',
        connection: { state: 'connected' },
      },
      { id: 'unknown', title: '기타 소스', origin: 'plugin', connection: { state: 'disconnected' } },
    ],
  } as unknown as ExternalSourceController;
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<ExternalSourceSettingsPanel controller={controller} />);
  });
  const controls = renderer.root.findAllByType('select');
  act(() => controls[0]!.props.onChange({ target: { value: 'text' } }));
  expect(renderer.root.findAllByProps({ className: 'external-source-settings-card' })).toHaveLength(1);
  act(() => renderer.root.findByProps({ 'aria-label': '텍스트 소스 즐겨찾기' }).props.onClick());
  expect(setItem).toHaveBeenCalledWith('moya.source-favorites.v1', '["text"]');
  act(() => controls[0]!.props.onChange({ target: { value: 'all' } }));
  act(() => controls[1]!.props.onChange({ target: { value: 'all' } }));
  expect(renderer.root.findAllByProps({ className: 'external-source-settings-card' })).toHaveLength(1);
  expect(renderer.root.findByProps({ 'aria-label': '만화 소스 즐겨찾기' })).toBeDefined();
  act(() => controls[1]!.props.onChange({ target: { value: 'unknown' } }));
  expect(renderer.root.findByProps({ 'aria-label': '기타 소스 즐겨찾기' })).toBeDefined();
  act(() => renderer.unmount());
});
