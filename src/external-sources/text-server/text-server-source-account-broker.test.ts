import { describe, expect, it, vi } from 'vitest';
import type { ExternalSourceCredentialRecord } from '../contracts';
import type { ExternalSourceLocalState } from '../local-state';
import type { ExternalSourceSharedConnectionV1 } from '../../integration-settings/self-host-integration-settings';
import { createExternalSourceCredentialKey, unsealExternalSourceCredential } from '../device-credential-crypto';
import { TextServerSourceAccountBroker } from './text-server-source-account-broker';
import { textServerNamespace } from './text-server-client';
import { TEXT_SERVER_EXTERNAL_SOURCE_ID, TEXT_SERVER_PROFILE } from './text-server-external-source';

const identity = { instanceId: 'server', dataNamespace: 'data', label: '내 소설' };
const serverHealth = { ...identity, protocolVersion: 1, capabilities: ['catalog', 'txt-content'] };
const namespace = textServerNamespace(identity);
const json = (data: unknown) =>
  new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json', 'X-Moya-Source-Namespace': namespace },
  });

async function fixture() {
  const key = await createExternalSourceCredentialKey();
  let credential: ExternalSourceCredentialRecord | undefined;
  let shared: ExternalSourceSharedConnectionV1 | undefined;
  const state = {
    getOrCreateCredentialKey: async () => key,
    getCredential: async () => credential,
    saveCredential: async (value: ExternalSourceCredentialRecord) => {
      credential = value;
    },
    deleteCredential: async () => {
      credential = undefined;
    },
    getSharedConnection: async () => shared,
    saveSharedConnection: async (value: ExternalSourceSharedConnectionV1) => {
      shared = value;
    },
    deleteSharedConnection: async () => {
      shared = undefined;
    },
    clearCache: vi.fn(async () => undefined),
  } as unknown as ExternalSourceLocalState;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/health')) return json(serverHealth);
    if (path === '/v1/sources') return json({ items: [{ id: 'source', title: '소설' }] });
    if (path === '/v1/sources/source/works') return json({ items: [{ id: 'work', title: '작품' }] });
    if (path === '/v1/sources/source/works/work')
      return json({ id: 'work', title: '작품', seriesProfile: TEXT_SERVER_PROFILE });
    if (path.endsWith('/releases'))
      return json({ items: [{ id: 'one', title: '1화', sourceOrder: 1, revision: '"r1"' }] });
    if (path.endsWith('/content'))
      return new Response('본문\r\n  그대로  ', {
        headers: { 'Content-Type': 'text/plain', 'X-Moya-Source-Namespace': namespace, ETag: '"r1"' },
      });
    throw new Error('unexpected fixture route');
  });
  const broker = new TextServerSourceAccountBroker(TEXT_SERVER_EXTERNAL_SOURCE_ID, state, { fetchImpl });
  return { key, broker, state, fetchImpl, credential: () => credential, shared: () => shared };
}

describe('TextServerSourceAccountBroker', () => {
  it('returns artwork references without blocking metadata, reads images with auth and revokes them on disconnect', async () => {
    const f = await fixture();
    await f.broker.connect({ endpoint: 'https://text.test', token: 'private-token' });
    const signal = new AbortController().signal;
    const accountConnectionId = f.broker.status().accountConnectionId;
    f.fetchImpl.mockResolvedValueOnce(json({ items: [{ id: 'work', title: 'Cover work', hasCover: true }] }));
    const listed = await f.broker.list({ accountConnectionId, parentRef: 'text:["source"]' }, signal);
    const ref = listed.items[0]!.coverRef!;
    expect(ref.remoteId).toBe('text:["source","work"]');
    expect(f.fetchImpl.mock.calls.some(([url]) => String(url).endsWith('/cover'))).toBe(false);
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:cover-fixture');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    try {
      f.fetchImpl.mockResolvedValueOnce(
        new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: {
            'Content-Type': 'image/png',
            'X-Moya-Source-Namespace': namespace,
          },
        }),
      );
      expect(await f.broker.resolveCover(ref, signal)).toBe('blob:cover-fixture');
      expect(await f.broker.resolveCover(ref, signal)).toBe('blob:cover-fixture');
      expect(create).toHaveBeenCalledTimes(1);
      await f.broker.disconnect();
      expect(revoke).toHaveBeenCalledWith('blob:cover-fixture');
    } finally {
      create.mockRestore();
      revoke.mockRestore();
    }
  });
  it('connects, seals the token, and restores the same identity after endpoint/token changes', async () => {
    const f = await fixture();
    await f.broker.connect({ endpoint: 'https://text.test', token: 'private-token' });
    const original = f.broker.status().accountConnectionId;
    expect(f.shared()?.authMode).toBe('bearer');
    expect(JSON.stringify(f.shared())).not.toContain('private-token');
    expect(JSON.stringify(f.credential())).not.toContain('private-token');
    expect(await unsealExternalSourceCredential(f.credential()!.credentialEnvelope, f.key)).toMatchObject({
      token: 'private-token',
    });
    const restored = new TextServerSourceAccountBroker(TEXT_SERVER_EXTERNAL_SOURCE_ID, f.state, {
      fetchImpl: f.fetchImpl,
    });
    await restored.initialize();
    expect(restored.status().accountConnectionId).toBe(original);
    expect(restored.status().state).toBe('connected');
    await restored.connect({ endpoint: 'https://moved.test', token: 'new-token' });
    expect(restored.status().accountConnectionId).toBe(original);
    await restored.disconnect();
    expect(f.credential()).toBeUndefined();
    expect(f.shared()).toBeUndefined();
    expect(f.state.clearCache).toHaveBeenCalled();
  });

  it('projects source/work/release metadata and exact TXT bytes without extra health requests per release', async () => {
    const f = await fixture();
    await f.broker.connect({ endpoint: 'https://text.test' });
    const signal = new AbortController().signal;
    const accountConnectionId = f.broker.status().accountConnectionId;
    const sources = await f.broker.list({ accountConnectionId }, signal);
    const works = await f.broker.list({ accountConnectionId, parentRef: sources.items[0]!.navigationRef }, signal);
    const releases = await f.broker.list({ accountConnectionId, parentRef: works.items[0]!.navigationRef }, signal);
    const release = releases.items[0]!;
    expect(release.collection).toMatchObject({ title: '작품', seriesProfile: TEXT_SERVER_PROFILE });
    expect(release.release?.title).toBe('1화');
    expect(release.collection?.remoteId).toBe(works.items[0]!.navigationRef);
    const downloaded = await f.broker.download({ key: release.key, fileName: release.importFileName! }, signal);
    expect(await downloaded.content.file.text()).toBe('본문\r\n  그대로  ');
    expect(downloaded.remoteRevision).toBe(release.remoteRevision);
    expect(f.fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/health'))).toHaveLength(1);
    const before = f.fetchImpl.mock.calls.length;
    const generation = f.broker.status().connectionGeneration;
    await f.broker.refreshSharedConfiguration();
    expect(f.fetchImpl).toHaveBeenCalledTimes(before);
    expect(f.broker.status().connectionGeneration).toBe(generation);
  });

  it('sends search terms only to work listings and keeps opaque release cursors separate', async () => {
    const f = await fixture();
    await f.broker.connect({ endpoint: 'https://text.test' });
    const signal = new AbortController().signal;
    const accountConnectionId = f.broker.status().accountConnectionId;
    const query = '검색한 작품';
    const sources = await f.broker.list({ accountConnectionId, query }, signal);
    expect(new URL(String(f.fetchImpl.mock.calls.at(-1)![0])).search).toBe('');
    const works = await f.broker.list(
      { accountConnectionId, parentRef: sources.items[0]!.navigationRef, query, cursor: 'works:next' },
      signal,
    );
    const workUrl = new URL(String(f.fetchImpl.mock.calls.at(-1)![0]));
    expect(workUrl.searchParams.get('query')).toBe(query);
    expect(workUrl.searchParams.get('cursor')).toBe('works:next');
    await f.broker.list(
      { accountConnectionId, parentRef: works.items[0]!.navigationRef, query, cursor: 'releases:next' },
      signal,
    );
    const releaseUrl = f.fetchImpl.mock.calls
      .map(([url]) => new URL(String(url)))
      .find((url) => url.pathname.endsWith('/releases'))!;
    expect([...releaseUrl.searchParams]).toEqual([['cursor', 'releases:next']]);
  });

  it('uses only the configured managed port, requires explicit first connection and restores its public hint', async () => {
    const f = await fixture();
    const managedFetch = vi.fn(async () => json(serverHealth));
    const broker = new TextServerSourceAccountBroker(TEXT_SERVER_EXTERNAL_SOURCE_ID, f.state, { managedFetch });
    await broker.initialize();
    expect(managedFetch).not.toHaveBeenCalled();
    expect(broker.connectionForm().fields).toHaveLength(0);
    await broker.connect({ endpoint: 'https://untrusted.test', token: 'ignored-secret' });
    expect(managedFetch).toHaveBeenCalledWith('/v1/health', expect.any(AbortSignal));
    expect(f.shared()).toMatchObject({ authMode: 'managed', endpoint: '/api/integrations/text-sources' });
    expect(
      JSON.stringify(await unsealExternalSourceCredential(f.credential()!.credentialEnvelope, f.key)),
    ).not.toContain('ignored-secret');
    const restored = new TextServerSourceAccountBroker(TEXT_SERVER_EXTERNAL_SOURCE_ID, f.state, { managedFetch });
    await restored.initialize();
    expect(restored.status().state).toBe('connected');
    await restored.disconnect();
    const count = managedFetch.mock.calls.length;
    await restored.initialize();
    expect(managedFetch).toHaveBeenCalledTimes(count);
    expect(restored.status().state).toBe('disconnected');
  });

  it('rejects wrong account and changed response namespace before importing source content', async () => {
    const f = await fixture();
    await f.broker.connect({ endpoint: 'https://text.test' });
    const key = {
      connectorId: TEXT_SERVER_EXTERNAL_SOURCE_ID,
      accountConnectionId: f.broker.status().accountConnectionId,
      remoteId: 'text:["source","work","one"]',
    };
    await expect(
      f.broker.download(
        { key: { ...key, accountConnectionId: 'other' }, fileName: 'one.txt' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('연결');
    f.fetchImpl.mockResolvedValueOnce(
      new Response('different data', {
        headers: { 'Content-Type': 'text/plain', 'X-Moya-Source-Namespace': 'changed' },
      }),
    );
    await expect(f.broker.download({ key, fileName: 'one.txt' }, new AbortController().signal)).rejects.toThrow('범위');
  });

  it('disconnect aborts an active streamed download', async () => {
    const f = await fixture();
    await f.broker.connect({ endpoint: 'https://text.test' });
    const cancel = vi.fn();
    f.fetchImpl.mockResolvedValueOnce(
      new Response(new ReadableStream({ cancel }), {
        headers: { 'Content-Type': 'text/plain', 'X-Moya-Source-Namespace': namespace },
      }),
    );
    const pending = f.broker.download(
      {
        key: {
          connectorId: TEXT_SERVER_EXTERNAL_SOURCE_ID,
          accountConnectionId: f.broker.status().accountConnectionId,
          remoteId: 'text:["source","work","one"]',
        },
        fileName: 'one.txt',
      },
      new AbortController().signal,
    );
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    await f.broker.disconnect();
    await rejected;
    expect(cancel).toHaveBeenCalled();
  });
});
