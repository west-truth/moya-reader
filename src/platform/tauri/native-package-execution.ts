import type {
  ContentConnectionRequest,
  ContentConnectionStatus,
} from '../../../packages/extension-contracts/source-content-service';
import type { PackageExecutionPort } from '../../extensions/packages/package-runtime-catalog';
import type { VerifiedMoyaPackage } from '../../extensions/packages/package-archive';
import type { SourceMethod } from '@noveldesk/extension-contracts/source-protocol';
import type { SourceStateChanges, SourceStateValues } from '../../extensions/packages/source-state';
import { validateRepositoryIndex, type RepositoryEntry } from '../../extensions/packages/repository-contract';
import { packageOperationMessage } from '../../extensions/packages/package-operation-error';
import { NativeRequestQueue } from './native-request-queue';
import type { SourceAuthenticationRequest, SourceAuthenticationStatus } from '@noveldesk/extension-contracts/package';

type Connection = { endpoint: string };
import {
  MAX_SOURCE_CONTENT_BYTES,
  MAX_SOURCE_IMAGES,
  MAX_SOURCE_ASSET_BYTES,
  SOURCE_DOWNLOAD_TIMEOUT_MS,
} from '../../../packages/extension-runtime/content-limits.mjs';
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
const MAX_RESPONSE = MAX_SOURCE_CONTENT_BYTES + 2 * 1024 * 1024 + 4;
const requests = new NativeRequestQueue();
let sessionToken: string | undefined;

/** Binary HTTP transport to the app-owned helper, never guest code inside the WebView. */
export class NativePackageExecution implements PackageExecutionPort {
  readonly apk: import('../../extensions/packages/native-apk-catalog').NativeApkTransport = {
    request: (input, signal) =>
      this.request('/apk', JSON.stringify(input), signal, (response) => response.json(), 120000),
    invoke: (sourceId, method, input, signal) =>
      this.request(
        '/apk',
        JSON.stringify({ action: 'invoke', sourceId, method, input }),
        signal,
        decodeNativeAssets,
        method === 'source.listReleases'
          ? 11 * 60_000
          : method === 'source.getContent'
            ? SOURCE_DOWNLOAD_TIMEOUT_MS
            : 150000,
      ) as Promise<{ result: unknown; assets: ReadonlyMap<string, Blob> }>,
  };
  readonly runtime = 'tauri-native' as const;
  readonly mangayomi: import('../../extensions/packages/native-apk-catalog').NativeApkTransport = {
    request: (input, signal) =>
      this.request('/mangayomi', JSON.stringify(input), signal, (response) => response.json(), 150000),
    invoke: (sourceId, method, input, signal) =>
      this.request(
        '/mangayomi',
        JSON.stringify({ action: 'invoke', sourceId, method, input }),
        signal,
        decodeNativeAssets,
        method === 'source.listReleases'
          ? 11 * 60_000
          : method === 'source.getContent'
            ? SOURCE_DOWNLOAD_TIMEOUT_MS
            : 150000,
      ) as Promise<{ result: unknown; assets: ReadonlyMap<string, Blob> }>,
  };
  private token = (sessionToken ??= Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join(''));
  constructor(
    private readonly invokeImpl?: Invoke,
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}
  async ready(): Promise<Connection> {
    const invoke = this.invokeImpl ?? (await import('@tauri-apps/api/core')).invoke;
    return invoke<Connection>('desktop_extension_runtime_start', { sessionToken: this.token });
  }
  async listRepository(url: string, signal: AbortSignal) {
    return validateRepositoryIndex(
      await this.request('/repository-list', JSON.stringify({ url }), signal, (response) => response.json()),
      url,
    );
  }
  async downloadRepository(url: string, entry: RepositoryEntry, signal: AbortSignal) {
    return this.request('/repository-download', JSON.stringify({ url, entry }), signal, async (response) => {
      const blob = await response.blob();
      if (blob.size > 10 * 1024 * 1024) throw new Error('package_limit');
      return blob;
    }) as Promise<Blob>;
  }
  private async request(
    path: string,
    body: BodyInit,
    signal: AbortSignal | undefined,
    consume: (response: Response) => Promise<unknown>,
    timeoutMs = 60000,
  ) {
    return requests.run(
      () => this.requestNow(path, body, signal, consume, timeoutMs),
      signal,
      typeof body === 'string' && body.includes('"source.getCover"') ? 1 : 0,
    );
  }
  private async requestNow(
    path: string,
    body: BodyInit,
    signal: AbortSignal | undefined,
    consume: (response: Response) => Promise<unknown>,
    timeoutMs: number,
  ) {
    signal?.throwIfAborted();
    const { endpoint } = await this.ready();
    if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(endpoint)) throw new Error('native_runtime_endpoint_invalid');
    const abort = new AbortController();
    const cancel = () => abort.abort(signal?.reason);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const timeout = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(endpoint + path, {
        method: 'POST',
        body,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': body instanceof Blob ? 'application/octet-stream' : 'application/json',
        },
        signal: abort.signal,
        credentials: 'omit',
        redirect: 'error',
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'native_execution_failed' }));
        if (
          (path === '/apk' || path === '/mangayomi') &&
          [
            'apk_input_invalid',
            'compatibility_file_invalid',
            'compatibility_filter_unsupported',
            'compatibility_repository_mismatch',
            'compatibility_repository_invalid',
            'compatibility_feature_unsupported',
            'compatibility_preferences_invalid',
            'apk_worker_unavailable',
            'apk_publisher_changed',
            'apk_version_not_newer',
            'apk_install_conflict',
            'apk_repository_conflict',
            'apk_verification_failed',
            'apk_android_feature_unsupported',
            'apk_review_expired',
          ].includes(error?.error)
        )
          throw new Error(error.error);
        throw new Error(
          error?.error === 'package_not_prepared'
            ? 'package_not_prepared'
            : (packageOperationMessage(new Error(String(error?.error))) ??
                '확장 실행을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.'),
        );
      }
      return await consume(response);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof TypeError)
        throw Object.assign(new Error('앱의 확장 실행기와 연결이 끊겼습니다. 잠시 후 다시 시도해 주세요.'), {
          cause: error,
        });
      if (abort.signal.aborted)
        throw Object.assign(new Error('확장 응답 시간이 초과됐습니다. 다시 시도해 주세요.'), { cause: error });
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', cancel);
    }
  }
  async prepare(pkg: VerifiedMoyaPackage, signal?: AbortSignal) {
    await this.request('/prepare', pkg.archive, signal, async (response) => {
      const value = await response.json();
      if (value.digest !== pkg.digest) throw new Error('native_package_mismatch');
    });
  }
  async invoke(
    pkg: VerifiedMoyaPackage,
    method: SourceMethod,
    input: Record<string, unknown>,
    signal: AbortSignal,
    state?: SourceStateValues,
    credentialEpoch?: string,
  ) {
    const run = () =>
      this.request(
        '/invoke',
        JSON.stringify({ digest: pkg.digest, method, input, state, credentialEpoch }),
        signal,
        decodeNativeAssets,
        method === 'source.listReleases'
          ? 11 * 60_000
          : pkg.manifest.requestedAccess.webview ||
              (method === 'source.getContent' &&
                pkg.manifest.requestedAccess.contentServices?.some((entry) => entry.sourceId === input.sourceId))
            ? 150000
            : 60000,
      );
    try {
      return (await run()) as Awaited<ReturnType<PackageExecutionPort['invoke']>>;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'package_not_prepared') throw error;
      await this.prepare(pkg, signal);
      return (await run()) as Awaited<ReturnType<PackageExecutionPort['invoke']>>;
    }
  }
  async contentConnection(
    pkg: VerifiedMoyaPackage,
    sourceId: string,
    epoch: string,
    request: ContentConnectionRequest,
    signal: AbortSignal,
  ): Promise<ContentConnectionStatus> {
    const run = () =>
      this.request(
        '/content-connection',
        JSON.stringify({ digest: pkg.digest, sourceId, epoch, request }),
        signal,
        (response) => response.json(),
      );
    try {
      return (await run()) as ContentConnectionStatus;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'package_not_prepared') throw error;
      await this.prepare(pkg, signal);
      return (await run()) as ContentConnectionStatus;
    }
  }
  async preferences(
    pkg: VerifiedMoyaPackage,
    sourceId: string,
    epoch: string,
    request: import('../../../packages/extension-contracts/source-preferences').SourcePreferencesRequest,
    signal: AbortSignal,
  ): Promise<import('../../extensions/packages/compatibility-preferences').CompatibilityPreferences> {
    const run = () =>
      this.request(
        '/preferences',
        JSON.stringify({ digest: pkg.digest, sourceId, epoch, request }),
        signal,
        (response) => response.json(),
      );
    try {
      return (await run()) as import('../../extensions/packages/compatibility-preferences').CompatibilityPreferences;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'package_not_prepared') throw error;
      await this.prepare(pkg, signal);
      return (await run()) as import('../../extensions/packages/compatibility-preferences').CompatibilityPreferences;
    }
  }
  async authenticate(
    pkg: VerifiedMoyaPackage,
    sourceId: string,
    epoch: string,
    request: SourceAuthenticationRequest,
    signal: AbortSignal,
  ): Promise<SourceAuthenticationStatus> {
    const run = () =>
      this.request(
        '/authentication',
        JSON.stringify({ digest: pkg.digest, sourceId, epoch, request }),
        signal,
        (response) => response.json(),
      );
    try {
      return (await run()) as SourceAuthenticationStatus;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'package_not_prepared') throw error;
      await this.prepare(pkg, signal);
      return (await run()) as SourceAuthenticationStatus;
    }
  }
  async retainAuthentication(packageId: string, epoch: string | undefined) {
    await this.request('/credentials-retain', JSON.stringify({ packageId, epoch }), undefined, (response) =>
      response.json(),
    );
  }
  async checkUpdate(pkg: VerifiedMoyaPackage, signal: AbortSignal): Promise<Blob | undefined> {
    const consume = async (response: Response) => {
      if (response.status === 204) return undefined;
      const blob = await response.blob();
      if (blob.size > 10 * 1024 * 1024) throw new Error('package_limit');
      return blob;
    };
    const run = () =>
      this.request('/update', JSON.stringify({ digest: pkg.digest }), signal, consume) as Promise<Blob | undefined>;
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'package_not_prepared') throw error;
      await this.prepare(pkg, signal);
      return run();
    }
  }
}

export async function decodeNativeAssets(
  response: Response,
): Promise<{ result: unknown; assets: ReadonlyMap<string, Blob>; stateChanges?: SourceStateChanges }> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('invalid_native_response');
  // Consume one asset at a time: never duplicate the entire chapter into one ArrayBuffer.
  let pending = new Uint8Array(0),
    offset = 0,
    received = 0;
  const readParts = async (size: number): Promise<Uint8Array<ArrayBuffer>[]> => {
    const parts: Uint8Array<ArrayBuffer>[] = [];
    while (size > 0) {
      if (offset === pending.length) {
        const next = await reader.read();
        if (next.done) throw new Error('invalid_native_response');
        pending = next.value;
        offset = 0;
        received += pending.length;
        if (received > MAX_RESPONSE) throw new Error('native_response_limit');
        if (!pending.length) continue;
      }
      const take = Math.min(size, pending.length - offset);
      parts.push(Uint8Array.from(pending.subarray(offset, offset + take)));
      offset += take;
      size -= take;
    }
    return parts;
  };
  const readBytes = async (size: number) => {
    const parts = await readParts(size);
    const bytes = new Uint8Array(size);
    let index = 0;
    for (const part of parts) {
      bytes.set(part, index);
      index += part.length;
    }
    return bytes;
  };
  try {
    const prefix = await readBytes(4);
    const metadataSize = new DataView(prefix.buffer).getUint32(0);
    if (metadataSize > 2 * 1024 * 1024) throw new Error('invalid_native_response');
    const metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBytes(metadataSize)));
    if (!Array.isArray(metadata.assets) || metadata.assets.length > MAX_SOURCE_IMAGES)
      throw new Error('invalid_native_response');
    const assets = new Map<string, Blob>();
    let total = 0;
    for (const asset of metadata.assets) {
      if (
        !asset ||
        typeof asset.handle !== 'string' ||
        assets.has(asset.handle) ||
        typeof asset.type !== 'string' ||
        !Number.isSafeInteger(asset.size) ||
        asset.size < 1 ||
        asset.size > MAX_SOURCE_ASSET_BYTES
      )
        throw new Error('invalid_native_response');
      total += asset.size;
      if (total > MAX_SOURCE_CONTENT_BYTES) throw new Error('native_response_limit');
      assets.set(asset.handle, new Blob(await readParts(asset.size), { type: asset.type }));
    }
    if (offset !== pending.length) throw new Error('invalid_native_response');
    while (true) {
      const tail = await reader.read();
      if (tail.done) break;
      if (tail.value.length) throw new Error('invalid_native_response');
    }
    return { result: metadata.result, assets, stateChanges: metadata.stateChanges };
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
