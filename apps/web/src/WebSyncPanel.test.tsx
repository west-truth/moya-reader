import { create, act } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import { it, expect, vi } from 'vitest';
import WebSyncPanel from './WebSyncPanel';
import type { SyncPanelProps } from '../../../src/features/sync/sync-panel-contract';
vi.mock('../../../src/features/cloud-vault/CloudAccountsPanel', () => ({
  CloudAccountsPanel: () => <p>cloud content</p>,
}));
vi.mock('./WebDataSettings', () => ({ WebDataSettings: () => <p>storage content</p> }));
it('keeps web sync and offline settings inside the parent settings dialog', () => {
  const props = { embedded: true, data: {}, actions: { close: vi.fn() } } as unknown as SyncPanelProps;
  const markup = renderToStaticMarkup(<WebSyncPanel {...props} />);
  expect(markup).not.toContain('role="dialog"');
  expect(markup).toContain('cloud content');
  const renderer = create(<WebSyncPanel {...props} />);
  act(() => renderer.root.findAllByType('button')[1]!.props.onClick());
  expect(renderer.root.findByType('p').children).toEqual(['storage content']);
  expect(props.actions.close).not.toHaveBeenCalled();
  act(() => renderer.unmount());
});
