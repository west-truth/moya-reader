/** Trusted, server-side adapter ABI. No browser code, arbitrary module URLs, or automatic installation. */
export interface TextSourceWork {
  id: string;
  /** Nonempty display title, <=256 UTF-16 code units (same as the Moya broker). */
  title: string;
  /** <=256 UTF-16 code units. */
  author?: string;
  /** <=8192 UTF-16 code units. */
  description?: string;
  /** At most 50 tags, each nonempty and <=100 UTF-16 code units. */
  tags?: readonly string[];
  /** Artwork is fetched separately by work ID; upstream URLs never cross metadata. */
  hasCover?: boolean;
}
export interface TextSourceProfile {
  kind: 'document_series';
  format: 'txt';
  encoding: 'utf-8';
  chapterSplitMode: 'single';
}
export interface TextSourceRelease {
  id: string;
  /** Nonempty display title, <=256 UTF-16 code units. */
  title: string;
  sourceOrder: number;
  /** Optional ASCII quoted HTTP ETag (W/ allowed), <=256 characters; list and content must agree. */
  revision?: string;
}
export interface TextSourcePage<T> {
  items: readonly T[];
  /** Opaque <=512 characters. Adapter validates work/query scope and progression. */
  nextCursor?: string;
}
export interface TextSourcePageInput {
  cursor?: string;
  /** Registry normalizes an omitted limit to 50; allowed range is 1..100. */
  limit: number;
  signal?: AbortSignal;
}
/** Injected server-side body provider. The caller owns URL/scope validation; the provider owns bounded I/O and cleanup. */
export type ContentProvider = (url: string, signal?: AbortSignal) => Promise<Uint8Array>;

/** Optional lifecycle for host-injected drivers. Called at shutdown or partial startup failure. */
export type ManagedContentProvider = ContentProvider & { dispose?(): void | Promise<void> };
/** Driver validates its own data options. Code registration is trusted composition, never a module URL. */
export type ContentProviderFactory = (
  options: Record<string, unknown>,
) => ManagedContentProvider | Promise<ManagedContentProvider>;
export interface ContentProviderDefinition {
  /** Unique host-local binding ID; `default` is reserved for the existing global connection. */
  id: string;
  protocol: string;
  /** Host-only configuration; never included in adapter settings, SDK values or public catalogs. */
  options: Record<string, unknown>;
}
export interface SourceProviderBinding {
  /** Omit to retain the existing global connection; null means no injected provider; otherwise exact named binding. */
  contentProviderId?: string | null;
}

export interface TextSourceContent {
  /** Exact, owned UTF-8 bytes, nonempty and <=2 MiB; adapter must not mutate after returning. */
  bytes: Uint8Array;
  /** Same ASCII quoted wire ETag as the release list, when known. Omit instead of inventing a revision. */
  revision?: string;
}
export interface TextSourceAdapter {
  apiVersion: 1;
  /** Stable ID, [A-Za-z0-9_-]{1,128}, unique within a registry/dataNamespace. */
  id: string;
  /** Nonempty source display title, <=256 UTF-16 code units. */
  title: string;
  /** Defaults to ['txt-content']; search capability is required for a nonempty query. */
  capabilities?: readonly ('search' | 'txt-content' | 'cover-read')[];
  /** Required only with cover-read. Nonempty raster bytes, at most 8 MiB. */
  getCover?(input: { workId: string; signal?: AbortSignal }): Promise<{
    bytes: Uint8Array;
    contentType: 'image/jpeg' | 'image/png' | 'image/webp';
  }>;
  listWorks(input: TextSourcePageInput & { query?: string }): Promise<TextSourcePage<TextSourceWork>>;
  getWork(input: {
    workId: string;
    signal?: AbortSignal;
  }): Promise<TextSourceWork & { seriesProfile: TextSourceProfile; maxConcurrentDownloads?: 1 | 2 }>;
  listReleases(input: TextSourcePageInput & { workId: string }): Promise<TextSourcePage<TextSourceRelease>>;
  getContent(input: { workId: string; releaseId: string; signal?: AbortSignal }): Promise<TextSourceContent>;
}
