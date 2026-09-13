import { createHash, randomUUID } from 'node:crypto';
import type { VerifiedMoyaPackage } from '../../../../src/extensions/packages/package-archive.js';
import type { SourceContentRequest } from '@noveldesk/extension-contracts/source-sdk';

export interface ContentServiceScope {
  readonly packageId: string;
  readonly publisherFingerprint?: string;
  readonly digest: string;
  readonly sourceId: string;
  readonly url: string;
  readonly signal: AbortSignal;
}
/** Host-owned resolver: selecting a driver/connection is never delegated to the guest. */
export type SourceContentResolver = (scope: ContentServiceScope) => Promise<Uint8Array>;

/** Complete the service result after QuickJS exits; public results remain ordinary validated text assets. */
export async function materializeSourceContent(
  pkg: VerifiedMoyaPackage,
  sourceId: string,
  request: SourceContentRequest,
  signal: AbortSignal,
  resolve?: SourceContentResolver,
) {
  signal.throwIfAborted();
  const declaration = pkg.manifest.requestedAccess.contentServices?.find((entry) => entry.sourceId === sourceId);
  if (!declaration || !pkg.manifest.extension.permissions.includes('external.source.download'))
    throw new Error('source_content_service_denied');
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw new Error('source_content_service_denied');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    !declaration.origins.includes(url.origin)
  )
    throw new Error('source_content_service_denied');
  if (!resolve) throw new Error('source_content_service_required');
  const controller = new AbortController();
  const joined = AbortSignal.any([signal, controller.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    const cancelled = new Promise<never>((_, reject) => {
      cancel = () => reject(new Error(signal.aborted ? 'cancelled' : 'source_content_service_timeout'));
      joined.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => controller.abort(), 95000);
    });
    const bytes = await Promise.race([
      resolve({
        packageId: pkg.manifest.extension.id,
        publisherFingerprint: pkg.publisherFingerprint,
        digest: pkg.digest,
        sourceId,
        url: url.href,
        signal: joined,
      }),
      cancelled,
    ]);
    joined.throwIfAborted();
    if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > 2 * 1024 * 1024)
      throw new Error('source_body_limit');
    // Validate without decoding/re-encoding the asset (BOM/whitespace/newlines are retained).
    try {
      if (!new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim()) throw new Error();
    } catch {
      throw new Error('source_content_service_invalid');
    }
    const owned = Uint8Array.from(bytes);
    const asset = {
      handle: randomUUID(),
      byteLength: owned.byteLength,
      sha256: createHash('sha256').update(owned).digest('hex'),
      contentType: 'text/plain',
    };
    return {
      result: { kind: 'text' as const, asset },
      assets: new Map([[asset.handle, new Blob([owned], { type: asset.contentType })]]),
    };
  } finally {
    clearTimeout(timer);
    if (cancel) joined.removeEventListener('abort', cancel);
    controller.abort();
  }
}
