import { describe, expect, it, vi } from 'vitest';
import { syncEventId } from '../domain/identity/sync-identities';
import { SYNC_CONTRACT_V1, SYNC_CONTRACT_V2 } from '../sync/contract';
import type { SyncEvent } from '../sync/types';
import { RemoteApiError } from '../services/remote/remote-api-contracts';
import { RemoteSyncTransport } from '../services/remote/remote-sync-transport';

function currentEvent(): SyncEvent {
  return {
    ...SYNC_CONTRACT_V2,
    id: syncEventId({ userId: 'user_1', type: 'settings_updated', entityId: 'reader-settings', seed: 'event_1' }),
    type: 'settings_updated',
    deviceId: 'device_1',
    entityId: 'reader-settings',
    payload: { settings: { id: 'reader-settings', theme: 'light' } },
    createdAt: '2026-07-05T00:00:00.000Z',
  };
}

describe('RemoteSyncTransport capability negotiation', () => {
  it('never posts a v2 event when the capability endpoint identifies a legacy server', async () => {
    const request = vi.fn(async (path: string) => {
      if (path === '/sync/capabilities') throw new RemoteApiError('not found', 404);
      throw new Error(`unexpected request ${path}`);
    });
    const transport = new RemoteSyncTransport({ request });

    await expect(transport.pushSync([currentEvent()])).rejects.toThrow(/Refusing to send v2 sync event/);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('/sync/capabilities');
  });

  it('uses a descriptor-free v1 wire shape for a legacy server', async () => {
    const legacyEvent: SyncEvent = {
      id: 'sync_event_legacy',
      type: 'settings_updated',
      deviceId: 'device_1',
      entityId: 'reader-settings',
      payload: { settings: { id: 'reader-settings', theme: 'light' } },
      createdAt: '2026-07-05T00:00:00.000Z',
    };
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/sync/capabilities') throw new RemoteApiError('not found', 404);
      if (path === '/sync/events') {
        expect(JSON.parse(String(init?.body))).toEqual({ events: [legacyEvent] });
        return { accepted: 1, acceptedIds: [legacyEvent.id] };
      }
      if (path === '/sync?since=4') {
        return {
          cursor: 5,
          events: [
            {
              id: legacyEvent.id,
              type: legacyEvent.type,
              device_id: legacyEvent.deviceId,
              entity_id: legacyEvent.entityId,
              payload: legacyEvent.payload,
              created_at: legacyEvent.createdAt,
            },
          ],
        };
      }
      throw new Error(`unexpected request ${path}`);
    });
    const transport = new RemoteSyncTransport({ request });

    await expect(transport.pushSync([{ ...legacyEvent, ...SYNC_CONTRACT_V1 }])).resolves.toMatchObject({
      ...SYNC_CONTRACT_V1,
      accepted: 1,
    });
    await expect(transport.pullSync(4)).resolves.toMatchObject({
      ...SYNC_CONTRACT_V1,
      cursor: 5,
      events: [expect.objectContaining(SYNC_CONTRACT_V1)],
    });
  });

  it('requests and verifies the negotiated v2 pull envelope', async () => {
    const event = currentEvent();
    const request = vi.fn(async (path: string) => {
      if (path === '/sync/capabilities') {
        return {
          ...SYNC_CONTRACT_V2,
          supportedContracts: [SYNC_CONTRACT_V1, SYNC_CONTRACT_V2],
          defaultPullContract: SYNC_CONTRACT_V2,
        };
      }
      if (path.includes('/sync?since=2&contractVersion=2')) {
        return {
          ...SYNC_CONTRACT_V2,
          cursor: 3,
          events: [
            {
              ...SYNC_CONTRACT_V2,
              id: event.id,
              type: event.type,
              device_id: event.deviceId,
              entity_id: event.entityId,
              payload: event.payload,
              created_at: event.createdAt,
            },
          ],
        };
      }
      throw new Error(`unexpected request ${path}`);
    });
    const transport = new RemoteSyncTransport({ request });

    const result = await transport.pullSync(2);
    expect(result).toMatchObject({ ...SYNC_CONTRACT_V2, cursor: 3 });
    expect(result.events[0]).toMatchObject({ ...SYNC_CONTRACT_V2, id: event.id });
  });
});
