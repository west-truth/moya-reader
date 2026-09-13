import type { ExternalSourceContributionDescriptorV2 } from '@noveldesk/extension-contracts';
import type { SourceWork } from '@noveldesk/extension-contracts/source-sdk';
import { MAX_SOURCE_CONTENT_BYTES } from '../../packages/extension-runtime/content-limits.mjs';
import type { PackageRuntimeCatalog } from '../extensions/packages/package-runtime-catalog';
import type { ExternalSourceProviderRegistryPort } from './app-external-source-registry';
import type {
  ExternalItemKey,
  ExternalItemPage,
  ExternalSourceDownloadRef,
  ExternalSourceListInput,
  TrustedExternalSourceHostContext,
} from './contracts';

const fileName = (value: string, extension: string) =>
  `${
    Array.from(value, (char) => (char.charCodeAt(0) < 32 || /[<>:"/\\|?*]/.test(char) ? '_' : char))
      .join('')
      .slice(0, 160) || 'chapter'
  }.${extension}`;
const releaseRef = (workId: string, releaseId: string) => JSON.stringify([workId, releaseId]);
function parseRelease(value: string): [string, string] {
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    parsed.some((part) => typeof part !== 'string' || !part.length || part.length > 512)
  )
    throw new Error('invalid_source_release');
  return parsed as [string, string];
}

/** Adapter to the existing Source Hub/series download path. No new library or reader workflow. */
export type InstalledSourceCatalogPort = Pick<
  PackageRuntimeCatalog,
  'subscribe' | 'getSources' | 'getSource' | 'disable' | 'invoke'
>;
export class InstalledPackageSourceRegistry<
  Catalog extends InstalledSourceCatalogPort = PackageRuntimeCatalog,
> implements ExternalSourceProviderRegistryPort {
  private readonly workCache = new Map<string, { work: SourceWork; expiresAt: number }>();
  private readonly covers = new Map<string, string>();
  private readonly unsubscribe: () => void;
  constructor(protected readonly catalog: Catalog) {
    this.unsubscribe = catalog.subscribe(() => this.clearCache());
  }

  getExternalSources() {
    return this.catalog.getSources().map(({ descriptor }) => ({ descriptor, origin: 'plugin' as const }));
  }
  getExternalSourceStatus(id: string) {
    const source = this.catalog.getSource(id);
    return source
      ? { state: 'connected' as const, label: source.descriptor.title, connectionGeneration: source.generation }
      : { state: 'unavailable' as const, reason: '확장을 사용할 수 없습니다.' };
  }
  async connectExternalSource(id: string): Promise<void> {
    if (!this.catalog.getSource(id)) throw new Error('확장 설정에서 먼저 확장을 켜 주세요.');
  }
  async disconnectExternalSource(id: string): Promise<void> {
    await this.catalog.disable(id);
  }

  private descriptor(id: string): ExternalSourceContributionDescriptorV2 {
    const source = this.catalog.getSource(id);
    if (!source) throw new Error('package_source_unavailable');
    return source.descriptor;
  }
  private async work(id: string, workId: string, signal: AbortSignal): Promise<SourceWork> {
    const key = JSON.stringify([id, this.catalog.getSource(id)?.generation, workId]);
    const cached = this.workCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.work;
    const { result } = await this.catalog.invoke(id, 'source.getWork', { workId }, signal);
    if (this.workCache.size >= 64) this.workCache.delete(this.workCache.keys().next().value!);
    this.workCache.set(key, { work: result, expiresAt: Date.now() + 10 * 60 * 1000 });
    return result;
  }

  async listExternalSource(
    id: string,
    _context: TrustedExternalSourceHostContext,
    input: ExternalSourceListInput,
    signal: AbortSignal,
  ): Promise<ExternalItemPage> {
    const descriptor = this.descriptor(id);
    if (input.accountConnectionId) throw new Error('source_connection_mismatch');
    if (!input.parentRef) {
      const { result } = await this.catalog.invoke(
        id,
        'source.listWorks',
        { query: input.query, cursor: input.cursor, browseMode: input.browseMode, filters: input.filters },
        signal,
      );
      return {
        items: result.items.map((work) => ({
          key: { connectorId: id, remoteId: work.id },
          kind: 'work',
          title: work.title,
          author: work.author,
          navigationRef: work.id,
          remoteRevision: work.revision,
          importability: 'unsupported',
          coverRef: work.hasCover ? { connectorId: id, remoteId: work.id } : undefined,
        })),
        nextCursor: result.nextCursor,
        browse: result.browse ?? {
          activeMode: input.query ? 'search' : 'popular',
          availableModes: descriptor.capabilities.includes('search') ? ['popular', 'search'] : ['popular'],
        },
      };
    }
    const [work, response] = await Promise.all([
      this.work(id, input.parentRef, signal),
      this.catalog.invoke(id, 'source.listReleases', { workId: input.parentRef, cursor: input.cursor }, signal),
    ]);
    signal.throwIfAborted();
    const extension = descriptor.seriesProfile?.kind === 'document_series' ? 'txt' : 'cbz';
    const collection = {
      remoteId: work.id,
      title: work.title,
      author: work.author,
      description: work.description,
      tags: work.tags,
      seriesProfile: descriptor.seriesProfile!,
      maxConcurrentDownloads: 2 as const,
    };
    return {
      detail: {
        title: work.title,
        author: work.author,
        description: work.description,
        tags: work.tags,
        coverRef: work.hasCover ? { connectorId: id, remoteId: work.id } : undefined,
      },
      items: response.result.items.map((release) => ({
        key: { connectorId: id, remoteId: releaseRef(work.id, release.id) },
        kind: 'file',
        title: release.title,
        importFileName: fileName(release.title, extension),
        formatHint: extension,
        remoteRevision: release.revision,
        collection,
        release: { title: release.title, chapterNumber: release.number, sourceOrder: release.order },
        importability: 'supported',
      })),
      nextCursor: response.result.nextCursor,
    };
  }

  async downloadExternalSource(
    id: string,
    _context: TrustedExternalSourceHostContext,
    ref: ExternalSourceDownloadRef,
    signal: AbortSignal,
  ) {
    const source = this.catalog.getSource(id);
    if (
      !source ||
      ref.key.connectorId !== id ||
      ref.key.accountConnectionId ||
      (ref.context?.connectionGeneration && ref.context.connectionGeneration !== source.generation)
    )
      throw new Error('source_connection_mismatch');
    const [workId, releaseId] = parseRelease(ref.key.remoteId);
    const { result, assets } = await this.catalog.invoke(id, 'source.getContent', { workId, releaseId }, signal);
    const maximum = ref.context?.maxBytes ?? MAX_SOURCE_CONTENT_BYTES;
    if ([...assets.values()].reduce((sum, blob) => sum + blob.size, 0) > maximum) throw new Error('source_body_limit');
    if (result.kind === 'text') {
      const blob = assets.get(result.asset.handle)!;
      const file = new File([blob], fileName(ref.fileName.replace(/\.txt$/i, ''), 'txt'), { type: 'text/plain' });
      return {
        content: {
          kind: 'document' as const,
          file,
          format: 'txt' as const,
          encoding: 'utf-8' as const,
          chapterSplitMode: 'single' as const,
        },
        remoteRevision: ref.remoteRevision,
      };
    }
    // Keep image acquisition separate from packaging. The established comic importer consumes the resulting CBZ.
    const { BlobReader, BlobWriter, ZipWriter } = await import('@zip.js/zip.js');
    const writer = new ZipWriter(new BlobWriter('application/vnd.comicbook+zip'), { useWebWorkers: false });
    try {
      for (const [index, asset] of result.assets.entries()) {
        signal.throwIfAborted();
        const extension = (
          { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' } as Record<
            string,
            string
          >
        )[asset.contentType];
        if (!extension) throw new Error('unsupported_source_image');
        await writer.add(
          `${String(index + 1).padStart(5, '0')}.${extension}`,
          new BlobReader(assets.get(asset.handle)!),
          { level: 0 },
        );
      }
      const blob = await writer.close();
      signal.throwIfAborted();
      if (this.catalog.getSource(id)?.generation !== source.generation) throw new Error('package_generation_changed');
      const file = new File([blob], fileName(ref.fileName.replace(/\.cbz$/i, ''), 'cbz'), {
        type: 'application/vnd.comicbook+zip',
      });
      return {
        content: { kind: 'image_archive' as const, file, format: 'cbz' as const },
        remoteRevision: ref.remoteRevision,
      };
    } catch (error) {
      await writer.close().catch(() => undefined);
      throw error;
    }
  }

  async resolveExternalSourceCover(
    id: string,
    _context: TrustedExternalSourceHostContext,
    key: ExternalItemKey,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    if (key.connectorId !== id || key.accountConnectionId) throw new Error('source_connection_mismatch');
    const cacheKey = JSON.stringify([id, this.catalog.getSource(id)?.generation, key.remoteId]);
    const existing = this.covers.get(cacheKey);
    if (existing) return existing;
    const { result, assets } = await this.catalog.invoke(id, 'source.getCover', { workId: key.remoteId }, signal);
    if (!result) return undefined;
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(result.contentType))
      throw new Error('unsupported_source_image');
    const url = URL.createObjectURL(assets.get(result.handle)!);
    if (this.covers.size >= 64) {
      const first = this.covers.keys().next().value!;
      URL.revokeObjectURL(this.covers.get(first)!);
      this.covers.delete(first);
    }
    this.covers.set(cacheKey, url);
    return url;
  }

  private clearCache(): void {
    this.workCache.clear();
    this.releaseCovers();
  }
  releaseCovers(): void {
    for (const url of this.covers.values()) URL.revokeObjectURL(url);
    this.covers.clear();
  }
  dispose(): void {
    this.unsubscribe();
    this.clearCache();
  }
}
