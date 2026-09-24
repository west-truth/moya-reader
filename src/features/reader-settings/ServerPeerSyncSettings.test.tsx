import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RemoteApiClient } from '../../services/remote/remote-api-client';
import { ServerPeerSyncSettings } from './ServerPeerSyncSettings';

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
});

describe('server peer sync settings', () => {
  it('pairs the existing server, clears the password and starts the initial copy', async () => {
    let state: Record<string, unknown> = { configured: false };
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/sync/peer' && !init?.method) return state;
      if (path === '/sync/peer' && init?.method === 'POST') {
        state = { url: 'https://reader.example.com', status: 'ready' };
        return state;
      }
      if (path === '/sync/peer/bootstrap') return { restoredBooks: 1 };
      throw new Error(`unexpected ${path}`);
    });
    await act(async () => {
      renderer = create(
        <ServerPeerSyncSettings client={{ request: request as unknown as RemoteApiClient['request'] }} />,
      );
    });
    const inputs = renderer!.root.findAllByType('input');
    await act(async () => {
      inputs[0].props.onChange({ target: { value: 'https://reader.example.com' } });
      inputs[1].props.onChange({ target: { value: 'owner' } });
      inputs[2].props.onChange({ target: { value: 'secret password' } });
    });
    await act(async () => {
      renderer!.root.findByType('form').props.onSubmit({ preventDefault() {} });
    });
    expect(request).toHaveBeenCalledWith(
      '/sync/peer',
      {
        method: 'POST',
        body: JSON.stringify({
          url: 'https://reader.example.com',
          username: 'owner',
          password: 'secret password',
          startFromNow: true,
          requireEmptyLibrary: true,
        }),
      },
      20_000,
    );
    expect(request).toHaveBeenCalledWith('/sync/peer/bootstrap', { method: 'POST' }, 60 * 60_000 + 30_000);
    expect(renderer!.root.findAllByType('input')).toHaveLength(0);
  });

  it('shows a numeric transfer percentage only when the backup size is known', async () => {
    let state: Record<string, unknown> = {
      url: 'https://reader.example.com',
      status: 'bootstrapping',
      bootstrapProgress: { stage: 'downloading', completedBytes: 50, totalBytes: 100 },
    };
    const request = vi.fn(async () => state);
    await act(async () => {
      renderer = create(
        <ServerPeerSyncSettings client={{ request: request as unknown as RemoteApiClient['request'] }} />,
      );
    });
    expect(renderer!.root.findByProps({ role: 'progressbar' }).props['aria-valuenow']).toBe(50);
    state = {
      url: 'https://reader.example.com',
      status: 'bootstrapping',
      bootstrapProgress: { stage: 'downloading', completedBytes: 1024 },
    };
    await act(async () => renderer!.unmount());
    await act(async () => {
      renderer = create(
        <ServerPeerSyncSettings client={{ request: request as unknown as RemoteApiClient['request'] }} />,
      );
    });
    expect(renderer!.root.findByProps({ role: 'progressbar' }).props['aria-valuenow']).toBeUndefined();
    expect(renderer!.root.findByProps({ role: 'progressbar' }).props['aria-valuetext']).toBe('1 KB');
    state = {
      url: 'https://reader.example.com',
      status: 'bootstrapping',
      bootstrapProgress: { stage: 'validating' },
    };
    // Reopening the shared settings panel reads the current stage.
    await act(async () => renderer!.unmount());
    await act(async () => {
      renderer = create(
        <ServerPeerSyncSettings client={{ request: request as unknown as RemoteApiClient['request'] }} />,
      );
    });
    expect(renderer!.root.findByProps({ role: 'progressbar' }).props['aria-valuenow']).toBeUndefined();
  });
});
