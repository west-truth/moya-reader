import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TextServerRequestError } from '../../external-sources/text-server/text-server-errors';
import { filterAndSortReleases } from './source-release-list-model';
import { completeSeriesCatalog } from './complete-series-catalog';
import type { ExtensionContributionId, ExternalSourceContributionDescriptor } from '@noveldesk/extension-contracts';
import { persistentId128 } from '@noveldesk/text-core/hash';
import type { Chapter, Novel } from '../../domain/types';
import type {
  ExternalItemKey,
  ExternalItemSummary,
  ExternalSourceBrowseMode,
  ExternalSourceBrowseState,
  ExternalSourceConnectionForm,
  ExternalSourceConnectionInput,
  ExternalSourceConnectionStatus,
  ExternalSourceLink,
  ExternalSourceListInput,
  ExternalSourceFilterDefinition,
  ExternalSourceFilterValue,
  ExternalSourceWorkDetail,
  TrustedExternalSourceHostContext,
} from '../../external-sources/contracts';
import { externalItemKeyId, externalSourceLinkId } from '../../external-sources/contracts';
import type {
  ExternalSourceOrigin,
  ExternalSourceRegistryPort,
} from '../../external-sources/app-external-source-registry';
import {
  externalSourceCatalogPreferenceId,
  externalSourceDefaultFolderId,
  externalSourceSubscriptionId,
  type ExternalSourceCatalogPreference,
  type ExternalSourceDefaultFolder,
  type ExternalSourceLocalState,
  type ExternalSourceSubscriptionRecord,
} from '../../external-sources/local-state';
import type { ImportController, ImportProgress, ImportService } from '../../services/import/import-service';
import { hashBlobInChunks } from '../../services/import/chunked-file-reader';
import { readSeriesImageArchiveManifest } from '../../services/import/series-image-archive';
import type { BookAssetRepository } from '../../repositories/book-asset-repository';
import type { ToastTone } from '../../shared/ui/ToastHost';
import type { SuwayomiSeriesChapterInput } from '../../external-sources/suwayomi/suwayomi-series-cbz';
import {
  acquireExternalSourcePendingLinks,
  finalizeExternalSourceLinks,
  finalizeImporterResolvedExternalSourceLinks,
  reconcilePendingExternalSourceLinks,
  restoreExternalSourceLinks,
  saveExternalSourceLinks,
} from '../../external-sources/link-import-reconciliation';
import {
  externalReleaseRevisionChanged,
  externalItemSectionId,
  localSeriesDetail,
  projectLocalSeries,
  projectLocalSeriesReadingStates,
  type SerialReleaseReadingState,
} from './serial-work-projection';
import { projectImportProgress, type ImportTaskView } from '../import/import-task-projection';
import { externalDocumentCollectionId } from '../../external-sources/series/document-series-identity';
import { MAX_SOURCE_COVER_BYTES, persistSourceCover, sourceCoverContentType } from './source-cover';
import {
  collectSubscriptionReleasePages,
  mergeSeriesCatalogItems,
  MAX_SUBSCRIPTION_CHECK_TOTAL_PAGES,
  reconcileSubscriptionReleaseIds,
} from './series-catalog-pagination';

const CACHE_TTL_MS = 15 * 60 * 1_000;

function normalizedSourceHash(value: string | undefined): string | undefined {
  return value
    ?.replace(/^sha256:/iu, '')
    .trim()
    .toLocaleLowerCase();
}

async function importerResolvedSeriesIsActive(
  assets: BookAssetRepository | undefined,
  staged: readonly ExternalSourceLink[],
  novel: Novel,
): Promise<boolean | undefined> {
  if (!assets) return undefined;
  if (!novel.activeContentRevisionId || !novel.sourceContentHash) return false;
  const source = await assets.exportSource(novel.id);
  if (!source || normalizedSourceHash(source.metadata.contentHash) !== normalizedSourceHash(novel.sourceContentHash)) {
    return false;
  }
  const manifest = await readSeriesImageArchiveManifest(source.blob);
  if (!manifest) return false;
  const sections = new Map(manifest.chapters.map((chapter) => [chapter.remoteId, chapter]));
  return staged.every((link) => {
    const pending = link.pendingImport;
    const section = sections.get(link.source.remoteId);
    return Boolean(
      pending?.sourceHashResolvedByImporter &&
      section &&
      (!pending.collectionRemoteId || pending.collectionRemoteId === manifest.collection.remoteId) &&
      normalizedSourceHash(pending.importedSourceContentHash) === normalizedSourceHash(section.sourceContentHash),
    );
  });
}

type SerialItemSummary = ExternalItemSummary & Required<Pick<ExternalItemSummary, 'collection' | 'release'>>;
type SerialSourceItem = ExternalSourceItemView & SerialItemSummary;

interface ActiveSerialImportQueue {
  readonly sourceId: string;
  readonly collectionKey: string;
  readonly batchId: string;
  targetBookId: string;
  readonly externalWorkId?: string;
  readonly items: SerialSourceItem[];
  readonly itemKeys: Set<string>;
  readonly taskIdByItemKey: Map<string, string>;
  accepting: boolean;
}

export type { ExternalSourceRegistryPort } from '../../external-sources/app-external-source-registry';

export interface ExternalSourceView {
  readonly id: ExtensionContributionId;
  readonly title: string;
  readonly description?: string;
  readonly kind: ExternalSourceContributionDescriptor['kind'];
  readonly origin: ExternalSourceOrigin;
  readonly connection: ExternalSourceConnectionStatus;
  readonly connectionForm?: ExternalSourceConnectionForm;
  readonly supportsSubscriptions?: boolean;
  readonly newReleaseCount?: number;
}

export type ExternalSourceItemImportState = 'available' | 'imported' | 'update_available' | 'unsupported';

export interface ExternalSourceItemView extends ExternalItemSummary {
  readonly selected: boolean;
  readonly importState: ExternalSourceItemImportState;
  readonly localBookId?: string;
  readonly localBookTitle?: string;
  readonly readingState?: SerialReleaseReadingState;
  /** Local-only section order must not be compared with remote chapter numbers. */
  readonly localOrderOnly?: boolean;
}

export interface ExternalSourceLibraryWork extends ExternalSourceSubscriptionRecord {
  readonly localBookId?: string;
}

export interface ExternalSourceBreadcrumb {
  readonly label: string;
  readonly parentRef?: string;
}

export interface ExternalSourceImportProgress {
  readonly current: number;
  readonly total: number;
  readonly completed: number;
  readonly failed: number;
  readonly linkedExisting: number;
  readonly fileName?: string;
  readonly phase?: 'downloading' | 'verifying' | 'importing';
  readonly detail?: ImportProgress;
}

export interface ExternalSourceController {
  readonly open: boolean;
  readonly loading: boolean;
  readonly catalogLoading?: boolean;
  readonly catalogUpdateAvailable?: boolean;
  applyCatalogUpdate?(): void;
  readonly busy: boolean;
  readonly blockingBusy: boolean;
  readonly importBusy: boolean;
  readonly selectedBatchActive: boolean;
  readonly tasks: readonly ImportTaskView[];
  readonly linkedSeriesBookIds: ReadonlySet<string>;
  readonly sources: readonly ExternalSourceView[];
  readonly activeSourceId?: ExtensionContributionId;
  readonly items: readonly ExternalSourceItemView[];
  readonly query: string;
  readonly nextCursor?: string;
  readonly stale: boolean;
  readonly listError?: {
    readonly message: string;
    retry(): Promise<void>;
  };
  readonly detail?: ExternalSourceWorkDetail;
  readonly localSeriesNovel?: Novel;
  readonly localSeriesSourceId?: ExtensionContributionId;
  readonly browse?: ExternalSourceBrowseState;
  readonly filterValues: Readonly<Record<string, ExternalSourceFilterValue>>;
  readonly breadcrumbs: readonly ExternalSourceBreadcrumb[];
  readonly currentFolderIsDefault: boolean;
  readonly currentLocationCanBeDefault: boolean;
  readonly canPickItems: boolean;
  readonly canRemoveItems: boolean;
  readonly progress?: ExternalSourceImportProgress;
  readonly subscriptions: readonly ExternalSourceSubscriptionRecord[];
  readonly libraryWorks: readonly ExternalSourceLibraryWork[];
  readonly activeSubscription?: ExternalSourceSubscriptionRecord;
  readonly checkingSubscriptions: boolean;
  readonly canSubscribeCurrentWork: boolean;
  canQueueItem(item: ExternalSourceItemView): boolean;
  isWorkInLibrary(item: ExternalSourceItemView): boolean;
  addWorkToLibrary(item: ExternalSourceItemView): Promise<void>;
  addCurrentWorkToLibrary(): Promise<void>;
  removeLibraryWork(subscription: ExternalSourceSubscriptionRecord): Promise<void>;
  show(sourceId?: ExtensionContributionId): void;
  showLocalSeries(novel: Novel): Promise<void>;
  close(): void;
  selectSource(id: ExtensionContributionId): Promise<void>;
  setQuery(value: string): void;
  search(): Promise<void>;
  setBrowseMode(mode: Exclude<ExternalSourceBrowseMode, 'search'>): Promise<void>;
  setFilterValue(id: string, value: ExternalSourceFilterValue): void;
  applyFilters(): Promise<void>;
  resetFilters(): Promise<void>;
  refresh(): Promise<void>;
  loadMore(): Promise<void>;
  toggleItem(key: string): void;
  selectAllSupported(selected: boolean, itemKeys?: readonly string[]): void;
  importItem(item: ExternalSourceItemView): Promise<void>;
  importAndOpen(item: ExternalSourceItemView): Promise<void>;
  importSelected(): Promise<void>;
  openImported(item: ExternalSourceItemView): Promise<void>;
  cancel(): void;
  dismissTask(taskId: string): void;
  connect(input?: ExternalSourceConnectionInput): Promise<void>;
  disconnect(): Promise<void>;
  openItem(item: ExternalSourceItemView): Promise<void>;
  openFolder(item: ExternalSourceItemView): Promise<void>;
  goBack(): Promise<void>;
  setCurrentFolderAsDefault(): Promise<void>;
  clearDefaultFolder(): Promise<void>;
  pickItems(): Promise<void>;
  removeItem(item: ExternalSourceItemView): Promise<void>;
  subscribeCurrentWork(): Promise<void>;
  unsubscribeCurrentWork(): Promise<void>;
  acknowledgeNewReleases(): Promise<void>;
  selectNewReleases(): void;
  checkSubscriptions(): Promise<void>;
  openSubscription(subscription: ExternalSourceSubscriptionRecord): Promise<void>;
}

export interface UseExternalSourceControllerOptions {
  readonly registry: ExternalSourceRegistryPort;
  readonly hostContext: TrustedExternalSourceHostContext;
  readonly state: ExternalSourceLocalState;
  readonly importService: ImportService;
  readonly assets?: BookAssetRepository;
  /** The backing reader persists exact fixed-document section read markers. */
  readonly extensionRevision: number;
  readonly libraryRevision?: number;
  listNovels(options?: { includeTrash?: boolean }): Promise<Novel[]>;
  listChapters(novelId: string): Promise<Chapter[]>;
  getNovel(id: string): Promise<Novel | undefined>;
  openNovel(
    novel: Novel,
    target?: { readonly documentSectionId?: string; readonly documentSectionTitle?: string },
  ): void | Promise<void>;
  onLibraryChanged(): Promise<void>;
  onLibraryItemCommitted?(novel: Novel): Promise<void>;
  notify(message: string, tone?: ToastTone): void;
  confirm(message: string): boolean;
}

async function loadSourceLibrary(options: UseExternalSourceControllerOptions) {
  // Read links first: a catalog snapshot taken before a new link must never prune it.
  const links = await options.state.listLinks();
  const novels = await options.listNovels({ includeTrash: true });
  const reconciled = await reconcilePendingExternalSourceLinks(options.state, links, novels, Date.now(), {
    catalogIncludesTrash: true,
    resolveImporterApplied: (staged, novel) => importerResolvedSeriesIsActive(options.assets, staged, novel),
  });
  return { links: reconciled, novels, subscriptions: await options.state.listSubscriptions() };
}

function cachePageId(
  sourceId: string,
  accountConnectionId: string | undefined,
  input: ExternalSourceListInput,
): string {
  return [
    sourceId,
    accountConnectionId ?? '',
    input.parentRef ?? '',
    input.query?.trim() ?? '',
    input.browseMode ?? '',
    JSON.stringify(input.filters ?? []),
    input.cursor ?? '',
  ].join('\u0000');
}

function queryFingerprint(input: ExternalSourceListInput): string {
  return JSON.stringify({
    parentRef: input.parentRef ?? '',
    query: input.query?.trim() ?? '',
    browseMode: input.browseMode ?? '',
    filters: input.filters ?? [],
  });
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError';
}

function normalizedHash(value: string | undefined): string | undefined {
  return (
    value
      ?.replace(/^sha256:/i, '')
      .trim()
      .toLocaleLowerCase() || undefined
  );
}

function currentIso(): string {
  return new Date().toISOString();
}

function externalImportOperationId(scope: string): string {
  const nonce =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : Array.from(globalThis.crypto.getRandomValues(new Uint32Array(4)), (value) => value.toString(16)).join('');
  return persistentId128('external_import_operation', [scope, currentIso(), nonce]);
}

function isSerialSourceItem(item: ExternalSourceItemView): item is SerialSourceItem;
function isSerialSourceItem(item: ExternalItemSummary): item is SerialItemSummary;
function isSerialSourceItem(item: ExternalItemSummary): item is SerialItemSummary {
  return Boolean(item.collection?.remoteId && item.release?.title);
}

function serialCollectionKey(item: SerialItemSummary): string {
  return [item.key.connectorId, item.key.accountConnectionId ?? '', item.collection.remoteId].join('::');
}

function cacheSafeItems(items: readonly ExternalItemSummary[]): readonly ExternalItemSummary[] {
  return items.map((item) => (item.thumbnailUrl?.startsWith('blob:') ? { ...item, thumbnailUrl: undefined } : item));
}

async function persistentThumbnailUrl(value: string | undefined): Promise<string | undefined> {
  if (!value || !value.startsWith('blob:')) return value;
  try {
    const response = await fetch(value);
    if (!response.ok) return undefined;
    const declaredLength = Number(response.headers.get('Content-Length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_SOURCE_COVER_BYTES) return undefined;
    const blob = await response.blob();
    const contentType = sourceCoverContentType(blob.type || response.headers.get('Content-Type') || '');
    if (!contentType || blob.size === 0 || blob.size > MAX_SOURCE_COVER_BYTES) return undefined;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 32_768) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
    }
    return `data:${contentType};base64,${btoa(binary)}`;
  } catch {
    return undefined;
  }
}

function defaultFilterValues(
  definitions: readonly ExternalSourceFilterDefinition[] | undefined,
): Readonly<Record<string, ExternalSourceFilterValue>> {
  return Object.fromEntries(
    (definitions ?? []).flatMap((definition) =>
      'defaultValue' in definition ? [[definition.id, definition.defaultValue] as const] : [],
    ),
  );
}

function filterChanges(
  definitions: readonly ExternalSourceFilterDefinition[] | undefined,
  values: Readonly<Record<string, ExternalSourceFilterValue>>,
) {
  return (definitions ?? []).flatMap((definition) => {
    if (!('defaultValue' in definition)) return [];
    const value = values[definition.id] ?? definition.defaultValue;
    return [{ position: definition.position, groupPosition: definition.groupPosition, value }];
  });
}

export function useExternalSourceController(options: UseExternalSourceControllerOptions): ExternalSourceController {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [blockingBusy, setBusy] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogUpdateAvailable, setCatalogUpdateAvailable] = useState(false);
  const pendingCatalogApplyRef = useRef<() => void>();
  const applyCatalogUpdate = useCallback(() => {
    pendingCatalogApplyRef.current?.();
    pendingCatalogApplyRef.current = undefined;
    setCatalogUpdateAvailable(false);
  }, []);
  const [importBusy, setImportBusy] = useState(false);
  const [selectedBatchActive, setSelectedBatchActive] = useState(false);
  const [tasks, setTasks] = useState<ImportTaskView[]>([]);
  const busy = blockingBusy || importBusy;
  const [activeSourceId, setActiveSourceId] = useState<ExtensionContributionId>();
  const [catalogItems, setRawItems] = useState<readonly ExternalItemSummary[]>([]);
  const [coverUrls, setCoverUrls] = useState<ReadonlyMap<string, string>>(new Map());
  const rawItems = useMemo(
    () =>
      catalogItems.map((item) =>
        item.coverRef && coverUrls.has(externalItemKeyId(item.coverRef))
          ? { ...item, thumbnailUrl: coverUrls.get(externalItemKeyId(item.coverRef)) }
          : item,
      ),
    [catalogItems, coverUrls],
  );
  const [links, setLinks] = useState<readonly ExternalSourceLink[]>([]);
  const [novels, setNovels] = useState<readonly Novel[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [query, setQuery] = useState('');
  const [nextCursor, setNextCursor] = useState<string>();
  const [stale, setStale] = useState(false);
  const [listFailure, setListFailure] = useState<{
    message: string;
    input: ExternalSourceListInput;
    append: boolean;
    sourceId: ExtensionContributionId;
  }>();
  const [catalogDetail, setDetail] = useState<ExternalSourceWorkDetail>();
  const detail = useMemo(
    () =>
      catalogDetail?.coverRef && coverUrls.has(externalItemKeyId(catalogDetail.coverRef))
        ? { ...catalogDetail, thumbnailUrl: coverUrls.get(externalItemKeyId(catalogDetail.coverRef)) }
        : catalogDetail,
    [catalogDetail, coverUrls],
  );
  const [localSeriesBookId, setLocalSeriesBookId] = useState<string>();
  const [localSeriesSeedNovel, setLocalSeriesSeedNovel] = useState<Novel>();
  const [localSeriesSourceId, setLocalSeriesSourceId] = useState<ExtensionContributionId>();
  const [localSeriesReadingStates, setLocalSeriesReadingStates] = useState<
    ReadonlyMap<string, SerialReleaseReadingState>
  >(() => new Map());
  const [localSeriesChapters, setLocalSeriesChapters] = useState<readonly Chapter[]>([]);
  const [browse, setBrowse] = useState<ExternalSourceBrowseState>();
  const [filterValues, setFilterValues] = useState<Readonly<Record<string, ExternalSourceFilterValue>>>({});
  const [breadcrumbs, setBreadcrumbs] = useState<readonly ExternalSourceBreadcrumb[]>([{ label: '최상위 폴더' }]);
  const [defaultFolder, setDefaultFolder] = useState<ExternalSourceDefaultFolder>();
  const [progress, setProgress] = useState<ExternalSourceImportProgress>();
  const [subscriptions, setSubscriptions] = useState<readonly ExternalSourceSubscriptionRecord[]>([]);
  const [checkingSubscriptions, setCheckingSubscriptions] = useState(false);
  const [brokerRevision, setBrokerRevision] = useState(0);
  const listAbortRef = useRef<AbortController>();
  const localSeriesPageSeedRef = useRef<{
    sourceId?: string;
    accountConnectionId?: string;
    parentRef?: string;
    items: readonly ExternalItemSummary[];
    remoteItems: readonly ExternalItemSummary[];
    detail: ExternalSourceWorkDetail;
  }>();
  const itemNavigationPendingRef = useRef(false);
  const serialImportQueueRef = useRef<ActiveSerialImportQueue>();
  const downloadAbortRef = useRef<AbortController>();
  const subscriptionAbortRef = useRef<AbortController>();
  const foregroundSubscriptionChecksRef = useRef(new Set<string>());
  const subscriptionCheckOffsetsRef = useRef(new Map<string, number>());
  const importRef = useRef<ImportController>();
  const mountedRef = useRef(true);
  const openRef = useRef(open);

  const coverTargets = JSON.stringify([
    ...(detail?.coverRef ? [detail.coverRef] : []),
    ...rawItems.flatMap((item) => (item.coverRef ? [item.coverRef] : [])),
  ]);
  useEffect(() => {
    if (!open) return;
    const targets = JSON.parse(coverTargets) as ExternalItemKey[];
    const abort = new AbortController();
    const unique = [...new Map(targets.map((key) => [externalItemKeyId(key), key])).values()];
    let next = 0;
    const run = async () => {
      while (next < unique.length && !abort.signal.aborted) {
        const key = unique[next++]!;
        try {
          const thumbnailUrl = await optionsRef.current.registry.resolveExternalSourceCover?.(
            key.connectorId as ExtensionContributionId,
            optionsRef.current.hostContext,
            key,
            abort.signal,
          );
          if (abort.signal.aborted || !thumbnailUrl) continue;
          setCoverUrls((current) => new Map(current).set(externalItemKeyId(key), thumbnailUrl));
        } catch {
          /* Optional artwork never blocks catalog use or body downloads. */
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(3, unique.length) }, run));
    return () => abort.abort();
  }, [coverTargets, open, brokerRevision]);

  const resolveDetailThumbnail = useCallback(async (value: ExternalSourceWorkDetail, signal: AbortSignal) => {
    if (value.thumbnailUrl) return value.thumbnailUrl;
    if (!value.coverRef) return undefined;
    return optionsRef.current.registry.resolveExternalSourceCover?.(
      value.coverRef.connectorId as ExtensionContributionId,
      optionsRef.current.hostContext,
      value.coverRef,
      signal,
    );
  }, []);

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  const contributions = useMemo(() => {
    void options.extensionRevision;
    void brokerRevision;
    return options.registry.getExternalSources();
  }, [brokerRevision, options.extensionRevision, options.registry]);

  const sources = useMemo<readonly ExternalSourceView[]>(
    () =>
      contributions.map(({ descriptor, origin }) => {
        const connection = options.registry.getExternalSourceStatus(descriptor.id, options.hostContext);
        const sourceSubscriptions = subscriptions.filter(
          (item) =>
            item.connectorId === descriptor.id &&
            (item.accountConnectionId ?? '') === (connection.accountConnectionId ?? ''),
        );
        return {
          id: descriptor.id,
          title: descriptor.title,
          description: descriptor.description,
          kind: descriptor.kind,
          origin: origin ?? 'plugin',
          connection,
          connectionForm: options.registry.getExternalSourceConnectionForm?.(descriptor.id, options.hostContext),
          supportsSubscriptions: descriptor.capabilities.includes('subscriptions'),
          newReleaseCount: sourceSubscriptions.reduce((total, item) => total + item.newReleaseIds.length, 0),
        };
      }),
    [contributions, options.hostContext, options.registry, subscriptions],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      listAbortRef.current?.abort();
      downloadAbortRef.current?.abort();
      subscriptionAbortRef.current?.abort();
      importRef.current?.cancel();
    };
  }, []);

  useEffect(() => {
    let current = true;
    void loadSourceLibrary(optionsRef.current)
      .then(({ links, novels, subscriptions }) => {
        if (!current || !mountedRef.current) return;
        setSubscriptions(subscriptions);
        setLinks(links);
        setNovels(novels);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [options.extensionRevision, options.libraryRevision]);

  useEffect(() => {
    if (sources.length === 0) {
      setActiveSourceId(undefined);
      setOpen(false);
      setRawItems([]);
      setDetail(undefined);
      setDefaultFolder(undefined);
      return;
    }
    const activeSource = activeSourceId ? sources.find((source) => source.id === activeSourceId) : undefined;
    if (activeSource) {
      if (open && activeSource.connection.state !== 'connected' && !localSeriesBookId) setOpen(false);
      return;
    }
    if (open && !localSeriesBookId) setOpen(false);
    setActiveSourceId(sources[0]?.id);
    setDefaultFolder(undefined);
  }, [activeSourceId, localSeriesBookId, open, sources]);

  const currentParentRef = breadcrumbs.at(-1)?.parentRef;

  const refreshLocalProjection = useCallback(async () => {
    try {
      const next = await loadSourceLibrary(optionsRef.current);
      if (!mountedRef.current) return;
      setLinks(next.links);
      setNovels(next.novels);
      setSubscriptions(next.subscriptions);
    } catch (error) {
      optionsRef.current.notify(
        error instanceof Error ? error.message : '라이브러리를 확인하지 못했습니다. 다시 시도해 주세요.',
        'warning',
      );
    }
  }, []);

  const publishCommittedNovel = useCallback(
    async (novel: Novel) => {
      const links = await optionsRef.current.state.listLinks();
      // Recovery still needs an authoritative catalog read before reconciling pending links.
      if (links.some((link) => link.localBookId === novel.id && link.pendingImport)) {
        await refreshLocalProjection();
        return;
      }
      if (!mountedRef.current) return;
      setLinks(links);
      setNovels((current) => [...current.filter((item) => item.id !== novel.id), novel]);
    },
    [refreshLocalProjection],
  );

  const replaceSubscription = useCallback((next: ExternalSourceSubscriptionRecord) => {
    setSubscriptions((current) => [...current.filter((item) => item.id !== next.id), next]);
  }, []);

  const reconcileSubscriptionPage = useCallback(
    async (
      sourceId: string,
      accountConnectionId: string | undefined,
      parentRef: string | undefined,
      page: { readonly detail?: ExternalSourceWorkDetail; readonly items: readonly ExternalItemSummary[] },
      complete: boolean,
      isCurrent: () => boolean = () => true,
    ) => {
      if (!parentRef || !page.detail) return;
      const id = externalSourceSubscriptionId(sourceId, accountConnectionId, parentRef);
      const current = (await optionsRef.current.state.listSubscriptions(sourceId, accountConnectionId)).find(
        (item) => item.id === id,
      );
      if (!current || !mountedRef.current || !isCurrent()) return;
      const releaseIds = page.items.filter((item) => item.release).map((item) => item.key.remoteId);
      const thumbnailUrl = current.thumbnailUrl?.startsWith('data:')
        ? current.thumbnailUrl
        : await persistentThumbnailUrl(page.detail.thumbnailUrl);
      if (!mountedRef.current || !isCurrent()) return;
      const next: ExternalSourceSubscriptionRecord = {
        ...current,
        title: page.detail.title,
        author: page.detail.author,
        description: page.detail.description,
        thumbnailUrl: thumbnailUrl ?? current.thumbnailUrl,
        sourceLabel: page.detail.sourceLabel,
        ...reconcileSubscriptionReleaseIds(current, releaseIds, complete),
        lastCheckedAt: complete ? currentIso() : current.lastCheckedAt,
        updatedAt: currentIso(),
      };
      await optionsRef.current.state.saveSubscription(next);
      if (mountedRef.current && isCurrent()) replaceSubscription(next);
    },
    [replaceSubscription],
  );

  const persistCatalogPreference = useCallback(
    async (
      sourceId: ExtensionContributionId,
      parentRef: string | undefined,
      mode: Exclude<ExternalSourceBrowseMode, 'search'> | undefined,
      values: Readonly<Record<string, ExternalSourceFilterValue>>,
      definitions?: readonly ExternalSourceFilterDefinition[],
    ) => {
      if (!parentRef || !mode) return;
      const source = sources.find((candidate) => candidate.id === sourceId);
      if (source?.kind !== 'catalog' || source.connection.state !== 'connected') return;
      const preference = {
        id: externalSourceCatalogPreferenceId(sourceId, source.connection.accountConnectionId, parentRef),
        connectorId: sourceId,
        accountConnectionId: source.connection.accountConnectionId,
        parentRef,
        browseMode: mode,
        filterValues: values,
        filters: filterChanges(definitions, values),
        updatedAt: currentIso(),
        schemaVersion: 1,
      } satisfies ExternalSourceCatalogPreference;
      await optionsRef.current.state.saveCatalogPreference(preference);
    },
    [sources],
  );

  const loadPage = useCallback(
    async (
      input: ExternalSourceListInput,
      append: boolean,
      sourceOverride?: ExtensionContributionId,
      notifyFailure = true,
      forceRefresh = false,
    ): Promise<boolean | undefined> => {
      const sourceId = sourceOverride ?? activeSourceId;
      if (!sourceId || blockingBusy) return undefined;
      listAbortRef.current?.abort();
      pendingCatalogApplyRef.current = undefined;
      setCatalogUpdateAvailable(false);
      setListFailure(undefined);
      const connection = optionsRef.current.registry.getExternalSourceStatus(sourceId, optionsRef.current.hostContext);
      const seed = localSeriesPageSeedRef.current;
      const localSeed =
        seed?.sourceId === sourceId &&
        (seed.accountConnectionId ?? '') === (connection.accountConnectionId ?? '') &&
        seed.parentRef === input.parentRef &&
        !input.query &&
        !input.filters?.length
          ? seed
          : undefined;
      if (!localSeed) localSeriesPageSeedRef.current = undefined;
      if (connection.state !== 'connected') {
        setRawItems(localSeed?.items ?? []);
        setDetail(localSeed?.detail);
        setNextCursor(undefined);
        setStale(false);
        return false;
      }
      const abort = new AbortController();
      listAbortRef.current = abort;
      if (append) setCatalogLoading(true);
      else {
        setLoading(true);
        setCatalogLoading(false);
      }
      const normalizedInput: ExternalSourceListInput = {
        ...input,
        accountConnectionId: connection.accountConnectionId,
      };
      const id = cachePageId(sourceId, connection.accountConnectionId, normalizedInput);
      let cached =
        normalizedInput.parentRef && !normalizedInput.query
          ? await optionsRef.current.state.getCachePage(id).catch(() => undefined)
          : undefined;
      if (!mountedRef.current || abort.signal.aborted || listAbortRef.current !== abort) return;
      const snapshot = !append && cached?.completeSeries && !cached.nextCursor ? cached : undefined;
      const connectionIsCurrent = () => {
        const current = optionsRef.current.registry.getExternalSourceStatus(sourceId, optionsRef.current.hostContext);
        return (
          mountedRef.current &&
          !abort.signal.aborted &&
          listAbortRef.current === abort &&
          current.state === 'connected' &&
          current.connectionGeneration === connection.connectionGeneration &&
          (current.accountConnectionId ?? '') === (connection.accountConnectionId ?? '')
        );
      };
      if (!connectionIsCurrent()) {
        setLoading(false);
        setCatalogLoading(false);
        return;
      }
      const publish = (page: { items: readonly ExternalItemSummary[]; detail?: ExternalSourceWorkDetail }) => {
        if (localSeed) {
          localSeed.remoteItems = page.items;
          setRawItems(mergeSeriesCatalogItems(localSeed.items, page.items));
        } else setRawItems([...page.items]);
        setDetail(page.detail ?? localSeed?.detail);
        setNextCursor(undefined);
      };
      if (snapshot) {
        publish(snapshot);
        setLoading(false);
        setStale(false);
        if (!forceRefresh && Date.parse(snapshot.expiresAt) > Date.now()) {
          setCatalogLoading(false);
          return true;
        }
        setCatalogLoading(true);
      } else if (!append) setRawItems(localSeed?.items ?? []);
      try {
        let page = await optionsRef.current.registry.listExternalSource(
          sourceId,
          optionsRef.current.hostContext,
          normalizedInput,
          abort.signal,
        );
        if (!mountedRef.current || abort.signal.aborted || listAbortRef.current !== abort) return;
        const initialConnection = optionsRef.current.registry.getExternalSourceStatus(
          sourceId,
          optionsRef.current.hostContext,
        );
        if (
          initialConnection.state !== 'connected' ||
          initialConnection.connectionGeneration !== connection.connectionGeneration ||
          (initialConnection.accountConnectionId ?? '') !== (connection.accountConnectionId ?? '')
        )
          return;
        const series = !normalizedInput.cursor && Boolean(page.detail && !page.browse);
        if (series) {
          if (!snapshot) setDetail(page.detail ?? localSeed?.detail);
          page = await completeSeriesCatalog(
            page,
            (cursor) =>
              optionsRef.current.registry.listExternalSource(
                sourceId,
                optionsRef.current.hostContext,
                { ...normalizedInput, cursor },
                abort.signal,
              ),
            abort.signal,
          );
        }
        if (!mountedRef.current || abort.signal.aborted || listAbortRef.current !== abort) return;
        const currentConnection = optionsRef.current.registry.getExternalSourceStatus(
          sourceId,
          optionsRef.current.hostContext,
        );
        if (
          currentConnection.state !== 'connected' ||
          currentConnection.connectionGeneration !== connection.connectionGeneration ||
          (currentConnection.accountConnectionId ?? '') !== (connection.accountConnectionId ?? '')
        )
          return;
        if (snapshot && series) {
          const nextItems = cacheSafeItems(page.items);
          if (
            JSON.stringify(snapshot.items) !== JSON.stringify(nextItems) ||
            JSON.stringify(snapshot.detail) !== JSON.stringify({ ...page.detail, thumbnailUrl: undefined })
          ) {
            const update = page;
            pendingCatalogApplyRef.current = () => {
              if (connectionIsCurrent()) publish(update);
            };
            setCatalogUpdateAvailable(true);
          }
          const now = currentIso();
          await optionsRef.current.state.saveCachePage({
            ...snapshot,
            items: nextItems,
            detail: { ...page.detail!, thumbnailUrl: undefined },
            fetchedAt: now,
            expiresAt: new Date(Date.now() + CACHE_TTL_MS).toISOString(),
          });
          await reconcileSubscriptionPage(
            sourceId,
            connection.accountConnectionId,
            normalizedInput.parentRef,
            page,
            true,
            () => !abort.signal.aborted && listAbortRef.current === abort,
          ).catch(() => undefined);
          return true;
        }
        if (localSeed) {
          localSeed.remoteItems = mergeSeriesCatalogItems(
            [],
            [...(append ? localSeed.remoteItems : []), ...page.items],
          );
          setRawItems(mergeSeriesCatalogItems(localSeed.items, localSeed.remoteItems));
        } else {
          setRawItems((current) => mergeSeriesCatalogItems([], [...(append ? current : []), ...page.items]));
        }
        if (!append) setDetail(page.detail ?? localSeed?.detail);
        if (!append) {
          setBrowse(page.browse);
          if (page.browse?.filters) {
            setFilterValues((current) =>
              Object.keys(current).length > 0 ? current : defaultFilterValues(page.browse?.filters),
            );
          }
        }
        const visibleKeys = new Set(
          [...(localSeed?.items ?? []), ...(append ? rawItems : []), ...page.items].map((item) =>
            externalItemKeyId(item.key),
          ),
        );
        setSelectedKeys((current) => new Set([...current].filter((key) => visibleKeys.has(key))));
        setNextCursor(page.nextCursor);
        setStale(false);
        await reconcileSubscriptionPage(
          sourceId,
          connection.accountConnectionId,
          normalizedInput.parentRef,
          page,
          !normalizedInput.cursor && !page.nextCursor,
          () => !abort.signal.aborted && listAbortRef.current === abort,
        ).catch(() => undefined);
        const fetchedAt = currentIso();
        await optionsRef.current.state.saveCachePage({
          id,
          connectorId: sourceId,
          accountConnectionId: connection.accountConnectionId,
          queryFingerprint: queryFingerprint(normalizedInput),
          cursor: normalizedInput.cursor,
          nextCursor: page.nextCursor,
          items: cacheSafeItems(page.items),
          completeSeries: series || undefined,
          detail: series && page.detail ? { ...page.detail, thumbnailUrl: undefined } : undefined,
          browse: page.browse,
          fetchedAt,
          expiresAt: new Date(Date.now() + CACHE_TTL_MS).toISOString(),
          schemaVersion: 1,
        });
        if (!mountedRef.current || abort.signal.aborted || listAbortRef.current !== abort) return;
        return true;
      } catch (error) {
        if (isAbort(error) || !mountedRef.current || abort.signal.aborted || listAbortRef.current !== abort)
          return undefined;
        cached ??= await optionsRef.current.state.getCachePage(id).catch(() => undefined);
        if (!mountedRef.current || abort.signal.aborted || listAbortRef.current !== abort) return undefined;
        const failureMessage =
          error instanceof TextServerRequestError
            ? error.message
            : '외부 저장소 목록을 불러오지 못했습니다. 연결 상태를 확인하고 다시 시도해 주세요.';
        setListFailure({
          message: cached ? `${failureMessage} 마지막으로 받아 둔 목록을 표시합니다.` : failureMessage,
          // Cached pages are already visible. Refresh from the start instead of appending them twice.
          input: cached ? { ...input, cursor: undefined } : input,
          append: cached ? false : append,
          sourceId,
        });
        if (cached) {
          if (localSeed) {
            localSeed.remoteItems = mergeSeriesCatalogItems(
              [],
              [...(append ? localSeed.remoteItems : []), ...cached.items],
            );
            setRawItems(mergeSeriesCatalogItems(localSeed.items, localSeed.remoteItems));
          } else {
            const cachedItems = cached.items;
            setRawItems((current) => mergeSeriesCatalogItems([], [...(append ? current : []), ...cachedItems]));
          }
          if (!append) setDetail(cached.detail ?? localSeed?.detail);
          if (!append) {
            setBrowse(cached.browse);
            setFilterValues(defaultFilterValues(cached.browse?.filters));
          }
          setNextCursor(cached.nextCursor);
          setStale(true);
          optionsRef.current.notify(
            error instanceof TextServerRequestError
              ? `${error.message} 마지막으로 받아 둔 목록을 표시합니다.`
              : '외부 저장소를 새로고치지 못해 마지막 목록을 표시합니다.',
            'warning',
          );
          return true;
        } else {
          if (!append) {
            setRawItems(localSeed?.items ?? []);
            setDetail(localSeed?.detail);
            setBrowse(undefined);
            setNextCursor(undefined);
            setStale(false);
          }
          if (notifyFailure) {
            optionsRef.current.notify(
              error instanceof Error ? error.message : '외부 저장소 목록을 불러오지 못했습니다.',
              'danger',
            );
          }
          return false;
        }
      } finally {
        if (mountedRef.current && listAbortRef.current === abort) {
          setLoading(false);
          setCatalogLoading(false);
        }
      }
    },
    [activeSourceId, blockingBusy, rawItems, reconcileSubscriptionPage],
  );

  const loadSourceStart = useCallback(
    async (sourceId: ExtensionContributionId) => {
      listAbortRef.current?.abort();
      setListFailure(undefined);
      const connection = optionsRef.current.registry.getExternalSourceStatus(sourceId, optionsRef.current.hostContext);
      if (connection.state !== 'connected') return;
      const savedFolder = await optionsRef.current.state
        .getDefaultFolder(sourceId, connection.accountConnectionId)
        .catch(() => undefined);
      if (!mountedRef.current) return;
      setDefaultFolder(savedFolder);
      setQuery('');
      setRawItems([]);
      setDetail(undefined);
      setBrowse(undefined);
      setFilterValues({});
      setSelectedKeys(new Set());
      setNextCursor(undefined);
      setBreadcrumbs(savedFolder ? [{ label: '최상위 폴더' }, ...savedFolder.breadcrumbs] : [{ label: '최상위 폴더' }]);
      await refreshLocalProjection();
      const loaded = await loadPage({ parentRef: savedFolder?.parentRef }, false, sourceId, !savedFolder);
      if (!savedFolder || loaded !== false || !mountedRef.current) return;
      await optionsRef.current.state
        .deleteDefaultFolder(sourceId, connection.accountConnectionId)
        .catch(() => undefined);
      setDefaultFolder(undefined);
      setBreadcrumbs([{ label: '최상위 폴더' }]);
      optionsRef.current.notify('기본 폴더를 열 수 없어 최상위 폴더부터 표시합니다.', 'warning');
      await loadPage({ parentRef: undefined }, false, sourceId);
    },
    [loadPage, refreshLocalProjection],
  );

  const refresh = useCallback(async () => {
    if (!activeSourceId) return;
    await refreshLocalProjection();
    await loadPage(
      {
        parentRef: currentParentRef,
        query: query.trim() || undefined,
        browseMode: query.trim() ? 'search' : browse?.activeMode,
        filters: filterChanges(browse?.filters, filterValues),
      },
      false,
      undefined,
      true,
      true,
    );
  }, [activeSourceId, browse, currentParentRef, filterValues, loadPage, query, refreshLocalProjection]);

  const show = useCallback(
    (requestedSourceId?: ExtensionContributionId) => {
      if (blockingBusy) return;
      if (importBusy && requestedSourceId && requestedSourceId !== activeSourceId) return;
      if (importBusy && activeSourceId && (!requestedSourceId || requestedSourceId === activeSourceId)) {
        setOpen(true);
        return;
      }
      const sourceId =
        (requestedSourceId &&
        sources.some((source) => source.id === requestedSourceId && source.connection.state === 'connected')
          ? requestedSourceId
          : undefined) ??
        (activeSourceId &&
        sources.some((source) => source.id === activeSourceId && source.connection.state === 'connected')
          ? activeSourceId
          : undefined) ??
        sources.find((source) => source.connection.state === 'connected')?.id;
      if (!sourceId) return;
      setLocalSeriesBookId(undefined);
      setLocalSeriesSeedNovel(undefined);
      setLocalSeriesSourceId(undefined);
      setLocalSeriesReadingStates(new Map());
      setLocalSeriesChapters([]);
      setOpen(true);
      setActiveSourceId(sourceId);
      void loadSourceStart(sourceId);
    },
    [activeSourceId, blockingBusy, importBusy, loadSourceStart, sources],
  );

  const close = useCallback(() => {
    const wasOpen = openRef.current;
    listAbortRef.current?.abort();
    pendingCatalogApplyRef.current = undefined;
    setCatalogUpdateAvailable(false);
    setCatalogLoading(false);
    setListFailure(undefined);
    openRef.current = false;
    setOpen(false);
    if (!importBusy) {
      setLocalSeriesBookId(undefined);
      setLocalSeriesSeedNovel(undefined);
      setLocalSeriesSourceId(undefined);
      setLocalSeriesReadingStates(new Map());
      setLocalSeriesChapters([]);
    }
    if (importBusy && wasOpen) optionsRef.current.notify('다운로드는 백그라운드에서 계속됩니다.');
  }, [importBusy]);

  const showLocalSeries = useCallback(
    async (novel: Novel) => {
      if (blockingBusy) return;
      listAbortRef.current?.abort();
      const navigation = new AbortController();
      listAbortRef.current = navigation;
      setListFailure(undefined);
      const [allLinks, chapters, nextNovels] = await Promise.all([
        optionsRef.current.state.listLinks(),
        optionsRef.current.listChapters(novel.id),
        optionsRef.current.listNovels(),
      ]);
      if (!mountedRef.current || navigation.signal.aborted || listAbortRef.current !== navigation) return;
      const relatedLinks = allLinks.filter((link) => link.localBookId === novel.id && link.collectionRemoteId);
      // The caller may hold the pre-reader render snapshot. Prefer the just-loaded progress.
      novel = nextNovels.find((candidate) => candidate.id === novel.id) ?? novel;
      const sourceId = relatedLinks[0]?.source.connectorId as ExtensionContributionId | undefined;
      const collectionRemoteId = relatedLinks[0]?.collectionRemoteId;
      const local = projectLocalSeries(novel, chapters, allLinks);
      const localSeed = {
        sourceId,
        accountConnectionId: relatedLinks[0]?.source.accountConnectionId,
        parentRef: collectionRemoteId,
        items: local.items,
        remoteItems: [] as readonly ExternalItemSummary[],
        detail: localSeriesDetail(novel),
      };
      localSeriesPageSeedRef.current = localSeed;
      setLocalSeriesBookId(novel.id);
      setLocalSeriesSeedNovel(novel);
      setLocalSeriesSourceId(sourceId);
      setLocalSeriesReadingStates(projectLocalSeriesReadingStates(novel, chapters));
      setLocalSeriesChapters(chapters);
      setNovels([...nextNovels.filter((candidate) => candidate.id !== novel.id), novel]);
      setLinks(local.links);
      setRawItems(local.items);
      setDetail(localSeriesDetail(novel));
      setBrowse(undefined);
      setFilterValues({});
      setSelectedKeys(new Set());
      setNextCursor(undefined);
      setStale(false);
      setQuery('');
      setDefaultFolder(undefined);
      setBreadcrumbs([{ label: '라이브러리' }, { label: novel.title, parentRef: collectionRemoteId }]);
      if (sourceId) setActiveSourceId(sourceId);
      setOpen(true);

      const source = sourceId ? sources.find((candidate) => candidate.id === sourceId) : undefined;
      if (!sourceId || !collectionRemoteId || source?.connection.state !== 'connected') return;
      const loaded = await loadPage({ parentRef: collectionRemoteId }, false, sourceId, false);
      if (!mountedRef.current || loaded === undefined || localSeriesPageSeedRef.current !== localSeed) return;
      setDetail((current) => current ?? localSeriesDetail(novel));
    },
    [blockingBusy, loadPage, sources],
  );

  const selectSource = useCallback(
    async (id: ExtensionContributionId) => {
      if (importBusy && id !== activeSourceId) return;
      listAbortRef.current?.abort();
      setListFailure(undefined);
      setLocalSeriesBookId(undefined);
      setLocalSeriesSeedNovel(undefined);
      setLocalSeriesSourceId(undefined);
      setLocalSeriesReadingStates(new Map());
      setLocalSeriesChapters([]);
      setActiveSourceId(id);
      await loadSourceStart(id);
    },
    [activeSourceId, importBusy, loadSourceStart],
  );

  const search = useCallback(async () => {
    await loadPage(
      {
        parentRef: currentParentRef,
        query: query.trim() || undefined,
        browseMode: query.trim() ? 'search' : browse?.activeMode,
        filters: filterChanges(browse?.filters, filterValues),
      },
      false,
    );
  }, [browse, currentParentRef, filterValues, loadPage, query]);

  const setBrowseMode = useCallback(
    async (mode: Exclude<ExternalSourceBrowseMode, 'search'>) => {
      setQuery('');
      const loaded = await loadPage(
        { parentRef: currentParentRef, browseMode: mode, filters: filterChanges(browse?.filters, filterValues) },
        false,
      );
      if (loaded !== false && activeSourceId) {
        await persistCatalogPreference(activeSourceId, currentParentRef, mode, filterValues, browse?.filters).catch(
          () => undefined,
        );
      }
    },
    [activeSourceId, browse, currentParentRef, filterValues, loadPage, persistCatalogPreference],
  );

  const setFilterValue = useCallback((id: string, value: ExternalSourceFilterValue) => {
    setFilterValues((current) => ({ ...current, [id]: value }));
  }, []);

  const applyFilters = useCallback(async () => {
    const loaded = await loadPage(
      {
        parentRef: currentParentRef,
        query: query.trim() || undefined,
        browseMode: 'search',
        filters: filterChanges(browse?.filters, filterValues),
      },
      false,
    );
    if (loaded !== false && activeSourceId && !query.trim()) {
      await persistCatalogPreference(
        activeSourceId,
        currentParentRef,
        browse?.activeMode === 'latest' ? 'latest' : 'popular',
        filterValues,
        browse?.filters,
      ).catch(() => undefined);
    }
  }, [activeSourceId, browse, currentParentRef, filterValues, loadPage, persistCatalogPreference, query]);

  const resetFilters = useCallback(async () => {
    const defaults = defaultFilterValues(browse?.filters);
    setFilterValues(defaults);
    const loaded = await loadPage(
      {
        parentRef: currentParentRef,
        query: query.trim() || undefined,
        browseMode: query.trim() ? 'search' : browse?.activeMode,
        filters: filterChanges(browse?.filters, defaults),
      },
      false,
    );
    if (loaded !== false && activeSourceId && !query.trim()) {
      await persistCatalogPreference(
        activeSourceId,
        currentParentRef,
        browse?.activeMode === 'latest' ? 'latest' : 'popular',
        defaults,
        browse?.filters,
      ).catch(() => undefined);
    }
  }, [activeSourceId, browse, currentParentRef, loadPage, persistCatalogPreference, query]);

  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    await loadPage(
      {
        parentRef: currentParentRef,
        query: query.trim() || undefined,
        browseMode: query.trim() ? 'search' : browse?.activeMode,
        filters: filterChanges(browse?.filters, filterValues),
        cursor: nextCursor,
      },
      true,
    );
  }, [browse, currentParentRef, filterValues, loadPage, nextCursor, query]);

  const linkByKey = useMemo(() => new Map(links.map((link) => [externalItemKeyId(link.source), link])), [links]);
  const novelById = useMemo(() => new Map(novels.map((novel) => [novel.id, novel])), [novels]);
  const catalogNovel = useMemo(() => {
    if (localSeriesBookId || !detail || !open) return undefined;
    const account = sources.find((source) => source.id === activeSourceId)?.connection.accountConnectionId;
    const link = links.find(
      (candidate) =>
        candidate.source.connectorId === activeSourceId &&
        (candidate.source.accountConnectionId ?? '') === (account ?? '') &&
        candidate.collectionRemoteId === currentParentRef &&
        !novelById.get(candidate.localBookId)?.deletedAt,
    );
    return link ? novelById.get(link.localBookId) : undefined;
  }, [activeSourceId, currentParentRef, detail, links, localSeriesBookId, novelById, open, sources]);
  const [catalogChapters, setCatalogChapters] = useState<{ novel: Novel; chapters: readonly Chapter[] }>();
  useEffect(() => {
    let active = true;
    setCatalogChapters(undefined);
    if (catalogNovel) {
      void optionsRef.current
        .listChapters(catalogNovel.id)
        .then((chapters) => {
          if (active) setCatalogChapters({ novel: catalogNovel, chapters });
        })
        .catch(() => undefined);
    }
    return () => {
      active = false;
    };
  }, [catalogNovel]);
  const catalogReadingStates = useMemo(
    () =>
      catalogNovel && catalogChapters?.novel === catalogNovel
        ? projectLocalSeriesReadingStates(catalogNovel, catalogChapters.chapters, rawItems)
        : new Map<string, SerialReleaseReadingState>(),
    [catalogNovel, catalogChapters, rawItems],
  );
  const effectiveLocalSeriesReadingStates = useMemo(() => {
    if (!localSeriesBookId) return localSeriesReadingStates;
    const localNovel = novelById.get(localSeriesBookId) ?? localSeriesSeedNovel;
    if (!localNovel) return localSeriesReadingStates;
    const projected = projectLocalSeriesReadingStates(localNovel, localSeriesChapters, rawItems);
    if ([...projected.values()].includes('current')) return projected;
    const previousCurrent = [...localSeriesReadingStates].find(([, state]) => state === 'current')?.[0];
    if (!previousCurrent || !projected.has(previousCurrent)) return projected;
    return new Map(
      [...projected].map(([sectionId, state]) => [sectionId, sectionId === previousCurrent ? 'current' : state]),
    );
  }, [localSeriesBookId, localSeriesChapters, localSeriesReadingStates, localSeriesSeedNovel, novelById, rawItems]);
  const taskByItemKey = useMemo(
    () => new Map(tasks.flatMap((task) => (task.externalItemKey ? [[task.externalItemKey, task] as const] : []))),
    [tasks],
  );
  const items = useMemo<readonly ExternalSourceItemView[]>(() => {
    const remoteItems = localSeriesPageSeedRef.current?.remoteItems;
    const remoteKeys = remoteItems?.length
      ? new Set(remoteItems.map((item) => externalItemKeyId(item.key)))
      : undefined;
    return rawItems.map((item) => {
      const key = externalItemKeyId(item.key);
      const link = linkByKey.get(key);
      const linkedNovel = link ? novelById.get(link.localBookId) : undefined;
      const completedTask = taskByItemKey.get(key)?.phase === 'complete' ? taskByItemKey.get(key) : undefined;
      const completedNovel = completedTask?.targetBookId ? novelById.get(completedTask.targetBookId) : undefined;
      const localNovel =
        (linkedNovel?.deletedAt ? undefined : linkedNovel) ?? (completedNovel?.deletedAt ? undefined : completedNovel);
      const unsupported = item.kind === 'folder' || item.importability === 'unsupported';
      const changed = Boolean(link && externalReleaseRevisionChanged(item, link.importedRemoteRevision));
      return {
        ...item,
        selected: selectedKeys.has(key),
        importState: unsupported
          ? 'unsupported'
          : (link || completedTask) && localNovel
            ? changed
              ? 'update_available'
              : 'imported'
            : 'available',
        localBookId: localNovel?.id,
        localBookTitle: localNovel?.title,
        localOrderOnly: Boolean(localSeriesBookId && remoteKeys && !remoteKeys.has(key)),
        readingState: item.release
          ? ((localSeriesBookId ? effectiveLocalSeriesReadingStates : catalogReadingStates).get(
              externalItemSectionId(item),
            ) ?? 'unread')
          : undefined,
      };
    });
  }, [
    linkByKey,
    effectiveLocalSeriesReadingStates,
    catalogReadingStates,
    localSeriesBookId,
    novelById,
    rawItems,
    selectedKeys,
    taskByItemKey,
  ]);

  const linkedSeriesBookIds = useMemo(
    () => new Set(links.filter((link) => link.collectionRemoteId).map((link) => link.localBookId)),
    [links],
  );

  const activeSubscription = useMemo(() => {
    if (!activeSourceId || !currentParentRef) return undefined;
    const connection = sources.find((source) => source.id === activeSourceId)?.connection;
    return subscriptions.find(
      (item) =>
        item.connectorId === activeSourceId &&
        item.collectionRemoteId === currentParentRef &&
        (item.accountConnectionId ?? '') === (connection?.accountConnectionId ?? ''),
    );
  }, [activeSourceId, currentParentRef, sources, subscriptions]);

  const libraryWorks = useMemo<readonly ExternalSourceLibraryWork[]>(() => {
    const knownNovelIds = new Set(novels.filter((novel) => !novel.deletedAt).map((novel) => novel.id));
    return subscriptions
      .filter((subscription) => {
        const related = links.filter(
          (link) =>
            link.source.connectorId === subscription.connectorId &&
            (link.source.accountConnectionId ?? '') === (subscription.accountConnectionId ?? '') &&
            link.collectionRemoteId === subscription.collectionRemoteId,
        );
        return related.length === 0 || !related.every((link) => novelById.get(link.localBookId)?.deletedAt);
      })
      .map((subscription) => {
        const related = links.find(
          (link) =>
            link.source.connectorId === subscription.connectorId &&
            (link.source.accountConnectionId ?? '') === (subscription.accountConnectionId ?? '') &&
            link.collectionRemoteId === subscription.collectionRemoteId &&
            knownNovelIds.has(link.localBookId),
        );
        return related ? { ...subscription, localBookId: related.localBookId } : subscription;
      });
  }, [links, novels, novelById, subscriptions]);

  const isWorkInLibrary = useCallback(
    (item: ExternalSourceItemView) => {
      if (item.kind !== 'work' || !item.navigationRef) return false;
      return subscriptions.some(
        (subscription) =>
          subscription.connectorId === item.key.connectorId &&
          (subscription.accountConnectionId ?? '') === (item.key.accountConnectionId ?? '') &&
          subscription.collectionRemoteId === item.navigationRef,
      );
    },
    [subscriptions],
  );

  const acknowledgeImportedReleaseIds = useCallback(
    async (
      sourceId: string,
      accountConnectionId: string | undefined,
      collectionRemoteId: string,
      releaseIds: readonly string[],
    ) => {
      if (releaseIds.length === 0) return;
      const id = externalSourceSubscriptionId(sourceId, accountConnectionId, collectionRemoteId);
      const current = (await optionsRef.current.state.listSubscriptions(sourceId, accountConnectionId)).find(
        (item) => item.id === id,
      );
      if (!current) return;
      const acknowledged = new Set(releaseIds);
      const next = {
        ...current,
        newReleaseIds: current.newReleaseIds.filter((releaseId) => !acknowledged.has(releaseId)),
        updatedAt: currentIso(),
      } satisfies ExternalSourceSubscriptionRecord;
      await optionsRef.current.state.saveSubscription(next);
      if (mountedRef.current) replaceSubscription(next);
    },
    [replaceSubscription],
  );

  const toggleItem = useCallback((key: string) => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const selectAllSupported = useCallback(
    (selected: boolean, itemKeys?: readonly string[]) => {
      const scope = itemKeys ? new Set(itemKeys) : undefined;
      const eligible = items
        .filter(
          (item) => item.kind !== 'folder' && item.importState !== 'unsupported' && item.importState !== 'imported',
        )
        .map((item) => externalItemKeyId(item.key))
        .filter((key) => !scope || scope.has(key));
      setSelectedKeys((current) => {
        const next = scope ? new Set(current) : new Set<string>();
        for (const key of eligible) {
          if (selected) next.add(key);
          else next.delete(key);
        }
        return next;
      });
    },
    [items],
  );

  const canQueueItem = useCallback(
    (item: ExternalSourceItemView) => {
      const queue = serialImportQueueRef.current;
      return Boolean(
        importBusy &&
        queue?.accepting &&
        queue.sourceId === activeSourceId &&
        isSerialSourceItem(item) &&
        serialCollectionKey(item) === queue.collectionKey,
      );
    },
    [activeSourceId, importBusy],
  );

  const importSerialItems = useCallback(
    async (sourceId: ExtensionContributionId, initialItems: readonly SerialSourceItem[]): Promise<boolean> => {
      const importable = filterAndSortReleases(initialItems, '', 'all', 'asc') as SerialSourceItem[];
      const collectionKeys = new Set(importable.map(serialCollectionKey));
      if (collectionKeys.size !== 1) return false;
      const collection = importable[0]!.collection;
      const accountConnectionId = importable[0]!.key.accountConnectionId;
      const currentSubscription =
        subscriptions.find(
          (record) =>
            record.connectorId === sourceId &&
            (record.accountConnectionId ?? '') === (accountConnectionId ?? '') &&
            record.collectionRemoteId === collection.remoteId,
        ) ??
        (
          await optionsRef.current.state
            .listSubscriptions(sourceId, accountConnectionId)
            .catch(() => [] as readonly ExternalSourceSubscriptionRecord[])
        ).find((record) => record.collectionRemoteId === collection.remoteId);
      let sourceThumbnailUrl = detail?.thumbnailUrl ?? currentSubscription?.thumbnailUrl;
      const selectedUpdateCount = importable.filter((item) => item.importState === 'update_available').length;
      if (
        selectedUpdateCount > 0 &&
        !optionsRef.current.confirm(
          `${selectedUpdateCount}개 회차의 원격 revision이 변경되었습니다. 본문이나 회차 구성이 달라졌으면 기존 작품 ID를 유지한 채 갱신합니다. 완료된 회차는 이후 실패에도 유지됩니다. 계속할까요?`,
        )
      ) {
        return true;
      }

      if (collection.seriesProfile?.kind === 'document_series') {
        const batchId = `external-document-series-${crypto.randomUUID()}`;
        const taskIdByItemKey = new Map<string, string>();
        const serialQueue: ActiveSerialImportQueue = {
          sourceId,
          collectionKey: serialCollectionKey(importable[0]!),
          batchId,
          targetBookId: externalDocumentCollectionId(importable[0]!.key, collection.remoteId),
          externalWorkId: currentSubscription?.id,
          items: importable,
          itemKeys: new Set(importable.map((item) => externalItemKeyId(item.key))),
          taskIdByItemKey,
          accepting: true,
        };
        const queuedTasks = importable.map((item, index): ImportTaskView => {
          const itemKey = externalItemKeyId(item.key);
          const id = `${batchId}-${index}`;
          taskIdByItemKey.set(itemKey, id);
          return {
            id,
            batchId,
            source: 'external_source',
            title: collection.title,
            fileName: item.release.title,
            targetBookId: serialQueue.targetBookId,
            externalWorkId: currentSubscription?.id,
            externalItemKey: itemKey,
            phase: 'queued',
            current: index + 1,
            total: importable.length,
          };
        });
        setTasks((current) => [
          ...current.filter((task) => !task.externalItemKey || !taskIdByItemKey.has(task.externalItemKey)),
          ...queuedTasks,
        ]);
        serialImportQueueRef.current = serialQueue;
        const abort = new AbortController();
        downloadAbortRef.current = abort;
        setImportBusy(true);
        setSelectedBatchActive(true);
        let completed = 0;
        let replacedRelease = false;
        let coverAttempted = false;
        let coverWarning: string | undefined;
        try {
          const { importDocumentSeries } =
            await import('../../external-sources/series/document-series-import-coordinator');
          // Capture each accepted selection once. Additions made while a batch is
          // running are imported against its committed source in the next pass.
          for (let offset = 0; offset < importable.length;) {
            abort.signal.throwIfAborted();
            const selectedItems = importable.slice(offset, offset + 1);
            const committedBefore = completed;
            await importDocumentSeries({
              sourceId,
              items: selectedItems,
              registry: optionsRef.current.registry,
              hostContext: optionsRef.current.hostContext,
              state: optionsRef.current.state,
              assets: optionsRef.current.assets,
              importService: optionsRef.current.importService,
              getNovel: (id) => optionsRef.current.getNovel(id),
              signal: abort.signal,
              onReplacedRelease: () => {
                replacedRelease = true;
              },
              onProgress: (value) => {
                completed = committedBefore + value.committed;
                if (mountedRef.current) {
                  const activeKey = value.item && externalItemKeyId(value.item.key);
                  const batchKeys = new Set(value.items?.map((item) => externalItemKeyId(item.key)));
                  setTasks((current) =>
                    current.map((task) => {
                      if (task.batchId !== batchId || task.phase === 'complete' || task.phase === 'cancelling')
                        return task;
                      if (value.detail && task.externalItemKey && batchKeys.has(task.externalItemKey))
                        return { ...task, ...projectImportProgress(value.detail) };
                      if (activeKey === task.externalItemKey)
                        return { ...task, phase: value.stage ?? 'downloading', percent: undefined };
                      if (activeKey && task.phase === 'downloading') return { ...task, phase: 'verifying' };
                      return task;
                    }),
                  );
                  setProgress({
                    current: committedBefore + value.received,
                    total: importable.length,
                    completed,
                    failed: 0,
                    linkedExisting: 0,
                    fileName: value.title,
                    phase: value.detail ? 'importing' : 'downloading',
                    detail: value.detail,
                  });
                }
              },
              onCommitted: async (novel, committedItems) => {
                const keys = new Set(committedItems.map((item) => externalItemKeyId(item.key)));
                serialQueue.targetBookId = novel.id;
                if (mountedRef.current)
                  setTasks((current) =>
                    current.map((task) =>
                      task.batchId === batchId
                        ? {
                            ...task,
                            targetBookId: novel.id,
                            ...(task.externalItemKey && keys.has(task.externalItemKey)
                              ? { phase: 'complete' as const, percent: 100, error: undefined }
                              : {}),
                          }
                        : task,
                    ),
                  );
                await acknowledgeImportedReleaseIds(
                  sourceId,
                  accountConnectionId,
                  collection.remoteId,
                  committedItems.map((item) => item.key.remoteId),
                );
                if (mountedRef.current)
                  setSelectedKeys((current) => new Set([...current].filter((key) => !keys.has(key))));
                await Promise.all([publishCommittedNovel(novel), optionsRef.current.onLibraryItemCommitted?.(novel)]);
                if (!coverAttempted && (sourceThumbnailUrl || detail?.coverRef)) {
                  coverAttempted = true;
                  try {
                    sourceThumbnailUrl ??= await resolveDetailThumbnail(detail!, downloadAbortRef.current!.signal);
                    await persistSourceCover(optionsRef.current.assets, novel, sourceThumbnailUrl, abort.signal);
                  } catch (error) {
                    coverWarning = error instanceof Error ? error.message : '원격 표지를 저장하지 못했습니다.';
                  }
                }
              },
            });
            offset += selectedItems.length;
          }
          serialQueue.accepting = false;
          optionsRef.current.notify(
            `${collection.title}의 ${completed}개 회차를 저장하거나 확인했습니다.${
              replacedRelease ? ' 수정 회차에서 연결할 수 없는 위치·메모는 복구 대기로 보관합니다.' : ''
            }${coverWarning ? ` 표지는 저장하지 못했습니다. ${coverWarning}` : ''}`,
            coverWarning ? 'warning' : 'success',
          );
        } catch (error) {
          serialQueue.accepting = false;
          if (mountedRef.current)
            setTasks((current) =>
              current.map((task) =>
                task.batchId === batchId && task.phase !== 'complete'
                  ? {
                      ...task,
                      phase: 'failed',
                      percent: undefined,
                      error: isAbort(error)
                        ? '다운로드를 취소했습니다.'
                        : error instanceof Error
                          ? error.message
                          : '텍스트 회차를 가져오지 못했습니다.',
                    }
                  : task,
              ),
            );
          optionsRef.current.notify(
            `${completed}개 회차는 저장되었습니다. ${
              isAbort(error)
                ? '진행 중인 묶음 가져오기를 취소했습니다.'
                : error instanceof Error
                  ? error.message
                  : '텍스트 회차를 가져오지 못했습니다.'
            }`,
            'warning',
          );
        } finally {
          serialQueue.accepting = false;
          if (serialImportQueueRef.current === serialQueue) serialImportQueueRef.current = undefined;
          if (downloadAbortRef.current === abort) downloadAbortRef.current = undefined;
          await optionsRef.current.onLibraryChanged().catch(() => undefined);
          await refreshLocalProjection().catch(() => undefined);
          if (mountedRef.current) {
            setTasks((current) =>
              current.filter((task) => task.batchId !== batchId || (!abort.signal.aborted && task.phase === 'failed')),
            );
            setImportBusy(false);
            setSelectedBatchActive(false);
            setProgress(undefined);
          }
        }
        return true;
      }

      const batchId = `external-series-${Date.now()}-${collection.remoteId}`;
      const targetBookId = persistentId128('external_series', [serialCollectionKey(importable[0]!)]);
      const taskIdByItemKey = new Map<string, string>();
      const queuedTasks = importable.map((item, index) => {
        const itemKey = externalItemKeyId(item.key);
        const taskId = `${batchId}-${index}`;
        taskIdByItemKey.set(itemKey, taskId);
        return {
          id: taskId,
          batchId,
          source: 'external_source' as const,
          title: collection.title,
          fileName: item.release.title,
          targetBookId,
          externalWorkId: currentSubscription?.id,
          externalItemKey: itemKey,
          phase: 'queued' as const,
          current: index + 1,
          total: importable.length,
        };
      });
      setTasks((current) => [
        ...current.filter((task) => !task.externalItemKey || !taskIdByItemKey.has(task.externalItemKey)),
        ...queuedTasks,
      ]);
      const serialQueue: ActiveSerialImportQueue = {
        sourceId,
        collectionKey: serialCollectionKey(importable[0]!),
        batchId,
        targetBookId,
        externalWorkId: currentSubscription?.id,
        items: importable,
        itemKeys: new Set(importable.map((item) => externalItemKeyId(item.key))),
        taskIdByItemKey,
        accepting: true,
      };
      serialImportQueueRef.current = serialQueue;
      setImportBusy(true);
      const abort = new AbortController();
      downloadAbortRef.current = abort;
      let importedNovel: Novel | undefined;
      let changedCount = 0;
      let revisionChecked = 0;
      let stagedLinks: readonly ExternalSourceLink[] = [];
      let previousLinks: readonly ExternalSourceLink[] = [];
      let contentApplied = false;
      let coverWarning: string | undefined;
      let coverAttempted = false;
      let libraryProjectionPublished = false;
      const completedKeys = new Set<string>();
      let activeTaskId: string | undefined;
      try {
        let { novels: knownNovels, links: knownLinks } = await loadSourceLibrary(optionsRef.current);
        // Download/build/commit one chapter at a time. The selection is not one
        // growing upload, and completed chapters survive a later failure/cancel.
        for (let batchIndex = 0; batchIndex < importable.length; batchIndex += 1) {
          const selectedItem = importable[batchIndex]!;
          const selectedItemKey = externalItemKeyId(selectedItem.key);
          activeTaskId = taskIdByItemKey.get(selectedItemKey);
          stagedLinks = [];
          previousLinks = [];
          contentApplied = false;
          abort.signal.throwIfAborted();
          const sameConnection = (link: ExternalSourceLink) =>
            link.source.connectorId === importable[0]!.key.connectorId &&
            (link.source.accountConnectionId ?? '') === (importable[0]!.key.accountConnectionId ?? '');
          const relatedRemoteIds = new Set(
            rawItems
              .filter(isSerialSourceItem)
              .filter((item) => serialCollectionKey(item) === serialCollectionKey(importable[0]!))
              .map((item) => item.key.remoteId),
          );
          const relatedLinks = knownLinks.filter(
            (link) =>
              sameConnection(link) &&
              (link.collectionRemoteId === collection.remoteId || relatedRemoteIds.has(link.source.remoteId)),
          );
          const knownNovelIds = new Set(knownNovels.map((novel) => novel.id));
          const targetIds = new Set(
            relatedLinks.filter((link) => knownNovelIds.has(link.localBookId)).map((link) => link.localBookId),
          );
          if (targetIds.size > 1) {
            throw new Error(
              '이 작품의 회차가 여러 라이브러리 항목에 따로 연결되어 있습니다. 중복 작품 정리는 다음 마이그레이션 단계에서 지원합니다.',
            );
          }
          const existingLocalBookId = [...targetIds][0];
          if (existingLocalBookId) {
            serialQueue.targetBookId = existingLocalBookId;
            setTasks((current) =>
              current.map((task) => (task.batchId === batchId ? { ...task, targetBookId: existingLocalBookId } : task)),
            );
          }
          const existingNovel = existingLocalBookId
            ? knownNovels.find((novel) => novel.id === existingLocalBookId)
            : undefined;
          if (existingNovel?.deletedAt)
            throw new Error('휴지통에 있는 작품입니다. 복원하거나 영구 삭제한 뒤 다시 가져와 주세요.');
          const incrementalSeriesAppend = Boolean(
            optionsRef.current.importService.supportsIncrementalImageSeriesAppend &&
            existingNovel?.format === 'image_archive' &&
            existingNovel.activeContentRevisionId &&
            (existingNovel.documentSectionCount ?? 0) > 0 &&
            relatedLinks.some((link) => link.collectionRemoteId === collection.remoteId),
          );
          const existingSource =
            existingLocalBookId && !incrementalSeriesAppend
              ? await (
                  await import('../../repositories/comic-source-export')
                ).exportPortableBookSource(optionsRef.current.assets, existingLocalBookId)
              : undefined;
          if (existingLocalBookId && !incrementalSeriesAppend && !existingSource) {
            throw new Error('기존 연재 작품의 원본을 찾지 못해 회차를 안전하게 합칠 수 없습니다.');
          }
          const legacyLink = relatedLinks.find(
            (link) => link.localBookId === existingLocalBookId && !link.collectionRemoteId,
          );
          const legacyItem = legacyLink
            ? rawItems
                .filter(isSerialSourceItem)
                .find((item) => externalItemKeyId(item.key) === externalItemKeyId(legacyLink.source))
            : undefined;
          const existingLegacyChapter =
            legacyLink && legacyItem
              ? {
                  remoteId: legacyItem.key.remoteId,
                  release: legacyItem.release,
                  remoteRevision: legacyLink.importedRemoteRevision,
                  sourceContentHash:
                    normalizedHash(legacyLink.importedSourceContentHash) ??
                    normalizedHash(existingNovel?.sourceContentHash) ??
                    (existingSource
                      ? (normalizedHash(
                          await hashBlobInChunks(existingSource.blob, {
                            shouldCancel: () => abort.signal.aborted,
                          }),
                        ) ?? '')
                      : ''),
                }
              : undefined;

          const downloadedChapters: SuwayomiSeriesChapterInput[] = [];
          const checked = new Map<
            string,
            { item: SerialSourceItem; sourceHash: string; remoteRevision?: string; existingLink?: ExternalSourceLink }
          >();
          for (const item of [selectedItem]) {
            abort.signal.throwIfAborted();
            if (activeTaskId) {
              setTasks((current) =>
                current.map((task) =>
                  task.id === activeTaskId
                    ? { ...task, phase: 'downloading', percent: undefined, error: undefined }
                    : task,
                ),
              );
            }
            setProgress({
              current: batchIndex + 1,
              total: importable.length,
              completed: changedCount,
              failed: 0,
              linkedExisting: revisionChecked,
              fileName: item.title,
              phase: 'downloading',
            });
            const downloaded = await optionsRef.current.registry.downloadExternalSource(
              sourceId,
              optionsRef.current.hostContext,
              {
                key: item.key,
                fileName: item.importFileName ?? `${collection.title} - ${item.release.title}.cbz`,
                mimeType: item.mimeType,
                byteLength: item.byteLength,
                remoteRevision: item.remoteRevision,
              },
              abort.signal,
            );
            if (activeTaskId) {
              setTasks((current) =>
                current.map((task) =>
                  task.id === activeTaskId ? { ...task, phase: 'verifying', percent: undefined } : task,
                ),
              );
            }
            setProgress((current) => (current ? { ...current, phase: 'verifying' } : current));
            const sourceHash =
              normalizedHash(
                await hashBlobInChunks(downloaded.file, {
                  shouldCancel: () => abort.signal.aborted,
                }),
              ) ?? '';
            const existingLink = knownLinks.find(
              (link) =>
                existingNovel &&
                link.localBookId === existingNovel.id &&
                externalItemKeyId(link.source) === externalItemKeyId(item.key),
            );
            checked.set(externalItemKeyId(item.key), {
              item,
              sourceHash,
              remoteRevision: downloaded.remoteRevision ?? item.remoteRevision,
              existingLink,
            });
            if (existingLink && normalizedHash(existingLink.importedSourceContentHash) === normalizedHash(sourceHash)) {
              revisionChecked += 1;
              continue;
            }
            downloadedChapters.push({
              remoteId: item.key.remoteId,
              release: item.release,
              remoteRevision: downloaded.remoteRevision ?? item.remoteRevision,
              sourceContentHash: sourceHash,
              expectedPreviousSourceContentHash: existingLink?.importedSourceContentHash,
              file: downloaded.file,
            });
          }

          if (downloadedChapters.length > 0) {
            if (activeTaskId) {
              setTasks((current) =>
                current.map((task) =>
                  task.id === activeTaskId ? { ...task, phase: 'preparing', percent: undefined } : task,
                ),
              );
            }
            setProgress({
              current: batchIndex + 1,
              total: importable.length,
              completed: changedCount,
              failed: 0,
              linkedExisting: revisionChecked,
              fileName: collection.title,
              phase: 'importing',
            });
            const { buildSuwayomiSeriesArchive } = await import('../../external-sources/suwayomi/suwayomi-series-cbz');
            const aggregate = await buildSuwayomiSeriesArchive({
              collection,
              targetBookId: incrementalSeriesAppend ? existingLocalBookId : undefined,
              chapters: downloadedChapters,
              existingArchive: incrementalSeriesAppend ? undefined : existingSource?.blob,
              existingLegacyChapter: incrementalSeriesAppend ? undefined : existingLegacyChapter,
              signal: abort.signal,
            });
            const uploadedSourceContentHash = await hashBlobInChunks(aggregate, {
              shouldCancel: () => abort.signal.aborted,
            });
            const localBookId =
              existingLocalBookId ?? persistentId128('external_series', [serialCollectionKey(importable[0]!)]);
            const stagedAt = currentIso();
            const operationId = externalImportOperationId(serialCollectionKey(importable[0]!));
            const stagedByKey = new Map<string, ExternalSourceLink>();
            relatedLinks
              .filter((link) => link.localBookId === localBookId)
              .forEach((link) =>
                stagedByKey.set(externalItemKeyId(link.source), {
                  ...link,
                  collectionRemoteId: collection.remoteId,
                  pendingImport: {
                    operationId,
                    stagedAt,
                    hadExistingLink: true,
                    previousActiveContentRevisionId: existingNovel?.activeContentRevisionId,
                    expectedActiveSourceContentHash: uploadedSourceContentHash,
                    sourceHashResolvedByImporter: incrementalSeriesAppend || undefined,
                    collectionRemoteId: collection.remoteId,
                    importedRemoteRevision: link.importedRemoteRevision,
                    importedSourceContentHash: link.importedSourceContentHash,
                  },
                }),
              );
            checked.forEach(({ item, sourceHash, remoteRevision, existingLink }) => {
              stagedByKey.set(externalItemKeyId(item.key), {
                ...(existingLink ?? {
                  id: externalSourceLinkId(item.key),
                  source: item.key,
                  localBookId,
                  linkedAt: stagedAt,
                }),
                localBookId,
                collectionRemoteId: collection.remoteId,
                pendingImport: {
                  operationId,
                  stagedAt,
                  hadExistingLink: Boolean(existingLink),
                  previousActiveContentRevisionId: existingNovel?.activeContentRevisionId,
                  expectedActiveSourceContentHash: uploadedSourceContentHash,
                  sourceHashResolvedByImporter: incrementalSeriesAppend || undefined,
                  collectionRemoteId: collection.remoteId,
                  importedRemoteRevision: remoteRevision,
                  importedSourceContentHash: sourceHash,
                },
              });
            });
            const nextStagedLinks = [...stagedByKey.values()];
            previousLinks = relatedLinks;
            await acquireExternalSourcePendingLinks(optionsRef.current.state, nextStagedLinks);
            stagedLinks = nextStagedLinks;
            const controller = optionsRef.current.importService.importFile(
              {
                file: aggregate,
                encoding: 'auto',
                chapterSplitMode: 'auto',
                clientBookId: localBookId,
                ...(incrementalSeriesAppend
                  ? {
                      importMode: 'append_image_series' as const,
                      baseActiveContentRevisionId: existingNovel?.activeContentRevisionId,
                    }
                  : {}),
                ...(optionsRef.current.importService.supportsExpectedSourceContentHash
                  ? { expectedSourceContentHash: uploadedSourceContentHash }
                  : {}),
              },
              (progressDetail) => {
                if (!mountedRef.current) return;
                if (activeTaskId) {
                  const projection = projectImportProgress(progressDetail);
                  setTasks((current) =>
                    current.map((task) => (task.id === activeTaskId ? { ...task, ...projection } : task)),
                  );
                }
                setProgress({
                  current: batchIndex + 1,
                  total: importable.length,
                  completed: changedCount,
                  failed: 0,
                  linkedExisting: revisionChecked,
                  fileName: collection.title,
                  phase: 'importing',
                  detail: progressDetail,
                });
              },
            );
            importRef.current = controller;
            if (abort.signal.aborted) controller.cancel();
            const result = await controller.promise;
            importRef.current = undefined;
            contentApplied = true;
            changedCount += downloadedChapters.length;
            importedNovel = (await optionsRef.current.getNovel(result.novel.id).catch(() => undefined)) ?? result.novel;
          } else {
            importedNovel = existingNovel;
          }
          if (!importedNovel) throw new Error('가져온 연재 작품을 확인하지 못했습니다.');

          const linkedAt = currentIso();
          let nextLinks: readonly ExternalSourceLink[];
          if (stagedLinks.length > 0) {
            nextLinks = incrementalSeriesAppend
              ? await finalizeImporterResolvedExternalSourceLinks(optionsRef.current.state, stagedLinks, importedNovel)
              : await finalizeExternalSourceLinks(optionsRef.current.state, stagedLinks, importedNovel);
          } else {
            const byKey = new Map<string, ExternalSourceLink>();
            relatedLinks
              .filter((link) => link.localBookId === importedNovel!.id)
              .forEach((link) =>
                byKey.set(externalItemKeyId(link.source), {
                  ...link,
                  collectionRemoteId: collection.remoteId,
                  activeContentRevisionId: importedNovel!.activeContentRevisionId,
                  lastCheckedAt: linkedAt,
                }),
              );
            checked.forEach(({ item, sourceHash, remoteRevision, existingLink }) => {
              byKey.set(externalItemKeyId(item.key), {
                id: externalSourceLinkId(item.key),
                source: item.key,
                localBookId: importedNovel!.id,
                collectionRemoteId: collection.remoteId,
                importedRemoteRevision: remoteRevision,
                importedSourceContentHash: sourceHash,
                activeContentRevisionId: importedNovel!.activeContentRevisionId,
                linkedAt: existingLink?.linkedAt ?? linkedAt,
                lastCheckedAt: linkedAt,
              });
            });
            nextLinks = [...byKey.values()];
            await saveExternalSourceLinks(optionsRef.current.state, nextLinks);
          }
          await acknowledgeImportedReleaseIds(
            sourceId,
            importable[0]!.key.accountConnectionId,
            collection.remoteId,
            [...checked.values()].map(({ item }) => item.key.remoteId),
          );

          completedKeys.add(externalItemKeyId(selectedItem.key));
          const nextKeys = new Set(nextLinks.map((link) => externalItemKeyId(link.source)));
          knownLinks = [...knownLinks.filter((link) => !nextKeys.has(externalItemKeyId(link.source))), ...nextLinks];
          knownNovels = [...knownNovels.filter((novel) => novel.id !== importedNovel!.id), importedNovel];
          setLinks(knownLinks);
          setNovels(knownNovels);
          setSelectedKeys((current) => new Set([...current].filter((key) => key !== selectedItemKey)));
          setProgress((current) =>
            current
              ? { ...current, completed: changedCount, linkedExisting: revisionChecked, detail: undefined }
              : current,
          );
          if (activeTaskId) {
            const completedTaskId = activeTaskId;
            setTasks((current) =>
              current.map((task) =>
                task.id === completedTaskId
                  ? { ...task, phase: 'complete', percent: 100, targetBookId: importedNovel!.id }
                  : task,
              ),
            );
          }
          activeTaskId = undefined;
          if (importedNovel && !libraryProjectionPublished) {
            const published = await optionsRef.current
              .onLibraryItemCommitted?.(importedNovel)
              .then(() => true)
              .catch(() => false);
            libraryProjectionPublished = published ?? true;
          }
          // Content and its release link are usable at this point. Do not keep the
          // completed release visually blocked while optional cover persistence runs.
          if (!coverAttempted && downloadedChapters.length > 0 && sourceThumbnailUrl) {
            coverAttempted = true;
            try {
              await persistSourceCover(optionsRef.current.assets, importedNovel, sourceThumbnailUrl, abort.signal);
            } catch (error) {
              coverWarning = error instanceof Error ? error.message : '원격 표지를 저장하지 못했습니다.';
            }
          }
        }
        serialQueue.accepting = false;
        await optionsRef.current.onLibraryChanged();
        await refreshLocalProjection();
        setSelectedKeys((current) => new Set([...current].filter((key) => !completedKeys.has(key))));
        const importedMessage =
          changedCount > 0
            ? `${collection.title}에 ${changedCount}개 회차를 추가하거나 갱신했습니다.${revisionChecked > 0 ? ` ${revisionChecked}개 회차는 원문이 같아 연결 revision만 갱신했습니다.` : ''}`
            : `${revisionChecked}개 회차는 원문이 같아 연결 revision만 갱신했습니다.`;
        optionsRef.current.notify(
          coverWarning ? `${importedMessage} 표지는 저장하지 못했습니다. ${coverWarning}` : importedMessage,
          coverWarning ? 'warning' : 'success',
        );
      } catch (error) {
        importRef.current = undefined;
        if (!contentApplied && stagedLinks.length > 0) {
          await restoreExternalSourceLinks(optionsRef.current.state, stagedLinks, previousLinks).catch(() => undefined);
        }
        if (changedCount > 0 || completedKeys.size > 0) {
          await optionsRef.current.onLibraryChanged().catch(() => undefined);
          await refreshLocalProjection().catch(() => undefined);
          setSelectedKeys((current) => new Set([...current].filter((key) => !completedKeys.has(key))));
        }
        const cancelled = isAbort(error);
        const message = error instanceof Error ? error.message : '회차를 가져오지 못했습니다.';
        setTasks((current) =>
          cancelled
            ? current.filter((task) => task.batchId !== batchId)
            : current
                .filter((task) => task.batchId !== batchId || task.id === activeTaskId)
                .map((task) =>
                  task.id === activeTaskId ? { ...task, phase: 'failed', percent: undefined, error: message } : task,
                ),
        );
        optionsRef.current.notify(
          (changedCount > 0 ? `${changedCount}개 회차는 저장되었습니다. ` : '') +
            (contentApplied
              ? `연재 본문 적용은 완료했으며 소스 연결은 다음 새로고침에서 복구합니다. ${
                  error instanceof Error ? error.message : String(error || '')
                }`.trim()
              : cancelled
                ? '가져오기를 취소했습니다. 기존 연재 작품과 연결은 유지됩니다.'
                : `연재 작품을 적용하지 못해 기존 본문과 연결을 유지했습니다. ${
                    error instanceof Error ? error.message : String(error || '')
                  }`.trim()),
          'warning',
        );
      } finally {
        serialQueue.accepting = false;
        if (serialImportQueueRef.current === serialQueue) serialImportQueueRef.current = undefined;
        downloadAbortRef.current = undefined;
        importRef.current = undefined;
        if (mountedRef.current) {
          if (!activeTaskId) setTasks((current) => current.filter((task) => task.batchId !== batchId));
          setImportBusy(false);
          setProgress(undefined);
        }
      }
      return true;
    },
    [
      acknowledgeImportedReleaseIds,
      detail,
      rawItems,
      refreshLocalProjection,
      publishCommittedNovel,
      subscriptions,
      resolveDetailThumbnail,
    ],
  );

  const importItems = useCallback(
    async (selected: readonly ExternalSourceItemView[]) => {
      const sourceId = activeSourceId;
      const importable = selected.filter(
        (item) =>
          item.kind !== 'folder' &&
          item.importState !== 'unsupported' &&
          (item.importState !== 'imported' || item.collection?.seriesProfile?.kind === 'document_series'),
      );
      if (!sourceId || importable.length === 0) return;
      const serialItems = importable.filter((item): item is SerialSourceItem => isSerialSourceItem(item));
      if (importBusy) {
        const queue = serialImportQueueRef.current;
        const sameActiveSeries = Boolean(
          !blockingBusy &&
          queue?.accepting &&
          queue.sourceId === sourceId &&
          serialItems.length === importable.length &&
          serialItems.every((item) => serialCollectionKey(item) === queue.collectionKey),
        );
        if (!sameActiveSeries || !queue) return;
        const additions = (filterAndSortReleases(serialItems, '', 'all', 'asc') as SerialSourceItem[]).filter(
          (item) => !queue.itemKeys.has(externalItemKeyId(item.key)),
        );
        if (additions.length === 0) return;
        const firstIndex = queue.items.length;
        additions.forEach((item, offset) => {
          const itemKey = externalItemKeyId(item.key);
          const taskId = `${queue.batchId}-${firstIndex + offset}`;
          queue.items.push(item);
          queue.itemKeys.add(itemKey);
          queue.taskIdByItemKey.set(itemKey, taskId);
        });
        const total = queue.items.length;
        setTasks((current) => [
          ...current.map((task) => (task.batchId === queue.batchId ? { ...task, total } : task)),
          ...additions.map((item, offset) => ({
            id: queue.taskIdByItemKey.get(externalItemKeyId(item.key))!,
            batchId: queue.batchId,
            source: 'external_source' as const,
            title: item.collection.title,
            fileName: item.release.title,
            targetBookId: queue.targetBookId,
            externalWorkId: queue.externalWorkId,
            externalItemKey: externalItemKeyId(item.key),
            phase: 'queued' as const,
            current: firstIndex + offset + 1,
            total,
          })),
        ]);
        setProgress((current) => (current ? { ...current, total } : current));
        return;
      }
      if (busy) return;
      if (serialItems.length === importable.length && (await importSerialItems(sourceId, serialItems))) return;
      const selectedUpdateCount = importable.filter((item) => item.importState === 'update_available').length;
      if (
        selectedUpdateCount > 0 &&
        !optionsRef.current.confirm(
          `${selectedUpdateCount}개 작품의 원격 revision이 변경되었습니다. 계속하면 선택한 원문을 내려받아 해시를 확인하고, 실제 내용이 달라진 작품만 기존 작품 ID를 유지한 채 새 content revision으로 교체합니다. 실패한 작품은 현재 본문을 유지합니다. 계속할까요?`,
        )
      ) {
        return;
      }
      setImportBusy(true);
      let completed = 0;
      let failed = 0;
      let linkedExisting = 0;
      let updated = 0;
      let revisionChecked = 0;
      let linkRepairPending = 0;
      let cancelled = false;
      let firstFailureMessage: string | undefined;
      setProgress({ current: 0, total: importable.length, completed, failed, linkedExisting });
      try {
        const { novels: knownNovels, links } = await loadSourceLibrary(optionsRef.current);
        const knownLinks = new Map(links.map((link) => [externalItemKeyId(link.source), link]));
        for (const [index, item] of importable.entries()) {
          if (!mountedRef.current) break;
          const abort = new AbortController();
          downloadAbortRef.current = abort;
          let stagedLinks: readonly ExternalSourceLink[] = [];
          let previousLinks: readonly ExternalSourceLink[] = [];
          let contentApplied = false;
          setProgress({
            current: index + 1,
            total: importable.length,
            completed,
            failed,
            linkedExisting,
            fileName: item.title,
            phase: 'downloading',
          });
          try {
            const downloaded = await optionsRef.current.registry.downloadExternalSource(
              sourceId,
              optionsRef.current.hostContext,
              {
                key: item.key,
                fileName: item.importFileName ?? item.title,
                mimeType: item.mimeType,
                byteLength: item.byteLength,
                remoteRevision: item.remoteRevision,
              },
              abort.signal,
            );
            setProgress({
              current: index + 1,
              total: importable.length,
              completed,
              failed,
              linkedExisting,
              fileName: item.title,
              phase: 'verifying',
            });
            const sourceHash =
              normalizedHash(
                await hashBlobInChunks(downloaded.file, {
                  shouldCancel: () => abort.signal.aborted,
                }),
              ) ?? '';
            const existingLink = knownLinks.get(externalItemKeyId(item.key));
            let target = existingLink ? knownNovels.find((novel) => novel.id === existingLink.localBookId) : undefined;
            if (target?.deletedAt)
              throw new Error('휴지통에 있는 작품입니다. 복원하거나 영구 삭제한 뒤 다시 가져와 주세요.');
            if (!target) {
              target = knownNovels.find(
                (novel) =>
                  !novel.deletedAt &&
                  (normalizedHash(novel.sourceContentHash) === normalizedHash(sourceHash) ||
                    normalizedHash(novel.rawTextHash) === normalizedHash(sourceHash)),
              );
            }
            let importedNovel = target;
            const exactLinkedContent = Boolean(
              existingLink &&
              target &&
              normalizedHash(existingLink.importedSourceContentHash) === normalizedHash(sourceHash),
            );
            if (exactLinkedContent) {
              // Providers can advance metadata/revision without changing the exact source bytes.
              // In that case only the checked link revision advances; the active content stays untouched.
              revisionChecked += 1;
            } else if (!target || existingLink) {
              setProgress({
                current: index + 1,
                total: importable.length,
                completed,
                failed,
                linkedExisting,
                fileName: item.title,
                phase: 'importing',
              });
              const localBookId =
                existingLink?.localBookId ??
                target?.id ??
                persistentId128('external_item', [externalItemKeyId(item.key)]);
              const linkedAt = currentIso();
              const stagedLink: ExternalSourceLink = {
                ...(existingLink ?? {
                  id: externalSourceLinkId(item.key),
                  source: item.key,
                  localBookId,
                  linkedAt,
                }),
                localBookId,
                pendingImport: {
                  operationId: externalImportOperationId(externalItemKeyId(item.key)),
                  stagedAt: linkedAt,
                  hadExistingLink: Boolean(existingLink),
                  previousActiveContentRevisionId: target?.activeContentRevisionId,
                  expectedActiveSourceContentHash: sourceHash,
                  collectionRemoteId: existingLink?.collectionRemoteId,
                  importedRemoteRevision: downloaded.remoteRevision ?? item.remoteRevision,
                  importedSourceContentHash: sourceHash,
                },
              };
              previousLinks = existingLink ? [existingLink] : [];
              await acquireExternalSourcePendingLinks(optionsRef.current.state, [stagedLink]);
              stagedLinks = [stagedLink];

              const controller = optionsRef.current.importService.importFile(
                {
                  file: downloaded.file,
                  encoding: 'auto',
                  chapterSplitMode: 'auto',
                  clientBookId: localBookId,
                },
                (detail) => {
                  if (!mountedRef.current) return;
                  setProgress({
                    current: index + 1,
                    total: importable.length,
                    completed,
                    failed,
                    linkedExisting,
                    fileName: item.title,
                    phase: 'importing',
                    detail,
                  });
                },
              );
              importRef.current = controller;
              const result = await controller.promise;
              importRef.current = undefined;
              contentApplied = true;
              importedNovel =
                (await optionsRef.current.getNovel(result.novel.id).catch(() => undefined)) ?? result.novel;
              knownNovels.push(importedNovel);
              completed += 1;
              if (existingLink) updated += 1;
            } else {
              linkedExisting += 1;
            }
            if (!importedNovel) throw new Error('가져온 작품을 확인하지 못했습니다.');
            const linkedAt = currentIso();
            let link: ExternalSourceLink;
            if (stagedLinks.length > 0) {
              link = (await finalizeExternalSourceLinks(optionsRef.current.state, stagedLinks, importedNovel))[0]!;
            } else {
              link = {
                id: externalSourceLinkId(item.key),
                source: item.key,
                localBookId: importedNovel.id,
                importedRemoteRevision: downloaded.remoteRevision ?? item.remoteRevision,
                importedSourceContentHash: importedNovel.sourceContentHash ?? sourceHash,
                activeContentRevisionId: importedNovel.activeContentRevisionId,
                linkedAt: existingLink?.linkedAt ?? linkedAt,
                lastCheckedAt: linkedAt,
              };
              await saveExternalSourceLinks(optionsRef.current.state, [link]);
            }
            knownLinks.set(externalItemKeyId(item.key), link);
          } catch (error) {
            importRef.current = undefined;
            if (isAbort(error)) {
              if (stagedLinks.length > 0) {
                await restoreExternalSourceLinks(optionsRef.current.state, stagedLinks, previousLinks).catch(
                  () => undefined,
                );
              }
              cancelled = true;
              break;
            }
            if (contentApplied && stagedLinks.length > 0) {
              // The canonical content is already active and the pre-import intent is durable.
              // A later projection will finalize the link without reimporting the source.
              linkRepairPending += stagedLinks.length;
              continue;
            }
            if (stagedLinks.length > 0) {
              await restoreExternalSourceLinks(optionsRef.current.state, stagedLinks, previousLinks).catch(
                () => undefined,
              );
            }
            failed += 1;
            firstFailureMessage ??=
              error instanceof Error
                ? error.message.trim() || error.name || '외부 작품을 가져오지 못했습니다.'
                : String(error || '외부 작품을 가져오지 못했습니다.');
          }
        }
        await optionsRef.current.onLibraryChanged();
        await refreshLocalProjection();
        setSelectedKeys(new Set());
        const connected = completed - updated + linkedExisting;
        const successMessage = [
          connected > 0 ? `${connected}개 작품을 책장에 연결했습니다.` : undefined,
          updated > 0 ? `${updated}개 작품의 본문을 업데이트했습니다.` : undefined,
          revisionChecked > 0 ? `${revisionChecked}개 작품은 원문이 같아 연결 revision만 갱신했습니다.` : undefined,
          linkRepairPending > 0
            ? `${linkRepairPending}개 작품은 본문 적용을 마쳤고 소스 연결은 다음 새로고침에서 복구합니다.`
            : undefined,
        ]
          .filter((message): message is string => Boolean(message))
          .join(' ');
        optionsRef.current.notify(
          cancelled
            ? `${successMessage ? `${successMessage} ` : ''}가져오기를 취소했습니다. 취소된 작품은 기존 본문과 연결을 유지합니다.`
            : failed > 0
              ? `${successMessage ? `${successMessage} ` : ''}${failed}개는 적용하지 못해 기존 본문과 연결을 유지했습니다.${firstFailureMessage ? ` 첫 오류: ${firstFailureMessage}` : ''}`
              : successMessage || '선택한 작품에 적용할 변경 사항이 없습니다.',
          cancelled || failed > 0 || linkRepairPending > 0 ? 'warning' : 'success',
        );
      } catch (error) {
        optionsRef.current.notify(
          error instanceof Error ? error.message : '라이브러리를 확인하지 못했습니다. 다시 시도해 주세요.',
          'warning',
        );
      } finally {
        downloadAbortRef.current = undefined;
        importRef.current = undefined;
        if (mountedRef.current) {
          setImportBusy(false);
          setProgress(undefined);
        }
      }
    },
    [activeSourceId, blockingBusy, busy, importBusy, importSerialItems, refreshLocalProjection],
  );

  const importItem = useCallback(
    async (item: ExternalSourceItemView) => {
      await importItems([item]);
    },
    [importItems],
  );

  const importAndOpen = useCallback(
    async (item: ExternalSourceItemView) => {
      if (!item.release || item.importState !== 'available') return;
      await importItems([item]);
      if (!openRef.current) return;
      const link = (await optionsRef.current.state.listLinks(item.key.connectorId)).find(
        (candidate) => externalItemKeyId(candidate.source) === externalItemKeyId(item.key),
      );
      if (!link) return;
      const novel = await optionsRef.current.getNovel(link.localBookId);
      if (!novel || novel.deletedAt) return;
      setLocalSeriesBookId(novel.id);
      setLocalSeriesSeedNovel(novel);
      setLocalSeriesSourceId(item.key.connectorId as ExtensionContributionId);
      setLocalSeriesChapters(await optionsRef.current.listChapters(novel.id));
      setOpen(false);
      await optionsRef.current.openNovel(novel, {
        documentSectionId: externalItemSectionId(item),
        documentSectionTitle: item.release.title,
      });
    },
    [importItems],
  );

  const importSelected = useCallback(async () => {
    const selected = items.filter((item) => item.selected);
    if (selected.length === 0 || importBusy) return;
    setSelectedBatchActive(true);
    try {
      await importItems(selected);
    } finally {
      if (mountedRef.current) setSelectedBatchActive(false);
    }
  }, [importBusy, importItems, items]);

  const openImported = useCallback(
    async (item: ExternalSourceItemView) => {
      if (blockingBusy || !['imported', 'update_available'].includes(item.importState) || !item.localBookId) return;
      const novel = await optionsRef.current.getNovel(item.localBookId);
      if (!novel || novel.deletedAt) {
        await refreshLocalProjection();
        optionsRef.current.notify('작품의 보관 상태가 변경되어 목록을 갱신했습니다.', 'warning');
        return;
      }
      if (item.release) {
        const chapters = await optionsRef.current.listChapters(novel.id);
        setLocalSeriesBookId(novel.id);
        setLocalSeriesSeedNovel(novel);
        setLocalSeriesSourceId(item.key.connectorId as ExtensionContributionId);
        setLocalSeriesReadingStates(projectLocalSeriesReadingStates(novel, chapters, rawItems));
        setLocalSeriesChapters(chapters);
      } else {
        setLocalSeriesBookId(undefined);
        setLocalSeriesSeedNovel(undefined);
        setLocalSeriesSourceId(undefined);
        setLocalSeriesReadingStates(new Map());
        setLocalSeriesChapters([]);
      }
      setOpen(false);
      if (item.release)
        await optionsRef.current.openNovel(novel, {
          documentSectionId: externalItemSectionId(item),
          documentSectionTitle: item.release.title,
        });
      else await optionsRef.current.openNovel(novel);
    },
    [blockingBusy, rawItems, refreshLocalProjection],
  );

  const cancel = useCallback(() => {
    if (serialImportQueueRef.current) serialImportQueueRef.current.accepting = false;
    setTasks((current) =>
      current.map((task) =>
        task.phase !== 'complete' && task.phase !== 'failed' ? { ...task, phase: 'cancelling' } : task,
      ),
    );
    listAbortRef.current?.abort();
    downloadAbortRef.current?.abort();
    subscriptionAbortRef.current?.abort();
    importRef.current?.cancel();
  }, []);

  const dismissTask = useCallback((taskId: string) => {
    setTasks((current) =>
      current.filter((task) => task.id !== taskId || (task.phase !== 'failed' && task.phase !== 'cancelling')),
    );
  }, []);

  const connect = useCallback(
    async (input?: ExternalSourceConnectionInput) => {
      if (!activeSourceId || busy) return;
      setBusy(true);
      try {
        await optionsRef.current.registry.connectExternalSource(activeSourceId, optionsRef.current.hostContext, input);
        setBrokerRevision((value) => value + 1);
        await loadSourceStart(activeSourceId);
      } catch (error) {
        optionsRef.current.notify(
          error instanceof Error ? error.message : '외부 저장소 연결에 실패했습니다.',
          'danger',
        );
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    },
    [activeSourceId, busy, loadSourceStart],
  );

  const disconnect = useCallback(async () => {
    if (!activeSourceId || busy) return;
    if (!optionsRef.current.confirm('이 기기에서 외부 저장소 연결을 해제할까요? 이미 가져온 책은 유지됩니다.')) return;
    setBusy(true);
    try {
      await optionsRef.current.registry.disconnectExternalSource(activeSourceId, optionsRef.current.hostContext);
      listAbortRef.current?.abort();
      setListFailure(undefined);
      setRawItems([]);
      setDetail(undefined);
      setBrowse(undefined);
      setFilterValues({});
      await refreshLocalProjection();
      setSelectedKeys(new Set());
      setNextCursor(undefined);
      setBrokerRevision((value) => value + 1);
      optionsRef.current.notify('외부 저장소 연결을 해제했습니다.', 'success');
    } catch (error) {
      optionsRef.current.notify(
        error instanceof Error ? error.message : '외부 저장소 연결을 해제하지 못했습니다.',
        'danger',
      );
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [activeSourceId, busy, refreshLocalProjection]);

  const openItem = useCallback(
    async (item: ExternalSourceItemView) => {
      if (
        !item.navigationRef ||
        (item.kind !== 'folder' && item.kind !== 'work') ||
        blockingBusy ||
        itemNavigationPendingRef.current
      )
        return;
      itemNavigationPendingRef.current = true;
      listAbortRef.current?.abort();
      setListFailure(undefined);
      try {
        if (item.kind === 'work') setQuery('');
        const next = [...breadcrumbs, { label: item.title, parentRef: item.navigationRef }];
        setBreadcrumbs(next);
        setSelectedKeys(new Set());
        const connection = sources.find((source) => source.id === activeSourceId)?.connection;
        const preference = activeSourceId
          ? await optionsRef.current.state
              .getCatalogPreference(activeSourceId, connection?.accountConnectionId, item.navigationRef)
              .catch(() => undefined)
          : undefined;
        if (preference) setFilterValues(preference.filterValues);
        await loadPage(
          {
            parentRef: item.navigationRef,
            browseMode: preference?.browseMode,
            filters: preference?.filters,
          },
          false,
        );
      } finally {
        itemNavigationPendingRef.current = false;
      }
    },
    [activeSourceId, blockingBusy, breadcrumbs, loadPage, sources],
  );

  const openFolder = useCallback(
    async (item: ExternalSourceItemView) => {
      if (item.kind !== 'folder') return;
      await openItem(item);
    },
    [openItem],
  );

  const goBack = useCallback(async () => {
    if (localSeriesBookId) {
      close();
      return;
    }
    if (breadcrumbs.length <= 1) return;
    listAbortRef.current?.abort();
    setListFailure(undefined);
    const next = breadcrumbs.slice(0, -1);
    setBreadcrumbs(next);
    setSelectedKeys(new Set());
    const parentRef = next.at(-1)?.parentRef;
    const connection = sources.find((source) => source.id === activeSourceId)?.connection;
    const preference =
      activeSourceId && parentRef
        ? await optionsRef.current.state
            .getCatalogPreference(activeSourceId, connection?.accountConnectionId, parentRef)
            .catch(() => undefined)
        : undefined;
    if (preference) setFilterValues(preference.filterValues);
    await loadPage(
      {
        parentRef,
        browseMode: preference?.browseMode,
        filters: preference?.filters,
      },
      false,
    );
  }, [activeSourceId, breadcrumbs, close, loadPage, localSeriesBookId, sources]);

  const setCurrentFolderAsDefault = useCallback(async () => {
    if (!activeSourceId || !currentParentRef || busy) return;
    const connection = optionsRef.current.registry.getExternalSourceStatus(
      activeSourceId,
      optionsRef.current.hostContext,
    );
    if (connection.state !== 'connected') return;
    const path = breadcrumbs
      .slice(1)
      .filter((crumb): crumb is ExternalSourceBreadcrumb & { parentRef: string } => Boolean(crumb.parentRef))
      .map((crumb) => ({ label: crumb.label, parentRef: crumb.parentRef }));
    if (path.length === 0) return;
    const folder: ExternalSourceDefaultFolder = {
      id: externalSourceDefaultFolderId(activeSourceId, connection.accountConnectionId),
      connectorId: activeSourceId,
      accountConnectionId: connection.accountConnectionId,
      parentRef: currentParentRef,
      breadcrumbs: path,
      updatedAt: currentIso(),
      schemaVersion: 1,
    };
    try {
      await optionsRef.current.state.saveDefaultFolder(folder);
      if (!mountedRef.current) return;
      setDefaultFolder(folder);
      optionsRef.current.notify(`${path.at(-1)?.label ?? '현재 폴더'}를 기본 폴더로 설정했습니다.`, 'success');
    } catch (error) {
      optionsRef.current.notify(error instanceof Error ? error.message : '기본 폴더를 저장하지 못했습니다.', 'danger');
    }
  }, [activeSourceId, breadcrumbs, busy, currentParentRef]);

  const clearDefaultFolder = useCallback(async () => {
    if (!activeSourceId || busy) return;
    const connection = optionsRef.current.registry.getExternalSourceStatus(
      activeSourceId,
      optionsRef.current.hostContext,
    );
    try {
      await optionsRef.current.state.deleteDefaultFolder(activeSourceId, connection.accountConnectionId);
      if (!mountedRef.current) return;
      setDefaultFolder(undefined);
      optionsRef.current.notify('기본 폴더를 해제했습니다. 다음에는 최상위 폴더부터 엽니다.', 'success');
    } catch (error) {
      optionsRef.current.notify(error instanceof Error ? error.message : '기본 폴더를 해제하지 못했습니다.', 'danger');
    }
  }, [activeSourceId, busy]);

  const pickItems = useCallback(async () => {
    if (!activeSourceId || busy || !optionsRef.current.registry.pickExternalSource) return;
    if (!optionsRef.current.registry.canPickExternalSource?.(activeSourceId, optionsRef.current.hostContext)) return;
    setBusy(true);
    try {
      const result = await optionsRef.current.registry.pickExternalSource(
        activeSourceId,
        optionsRef.current.hostContext,
      );
      setBrokerRevision((value) => value + 1);
      await refreshLocalProjection();
      await loadPage({ query: query.trim() || undefined }, false, activeSourceId);
      if (result.selectedCount > 0) {
        optionsRef.current.notify(
          result.addedCount > 0
            ? `${result.addedCount}개 Google Drive 파일을 소스에 추가했습니다.`
            : '선택한 Google Drive 파일의 정보를 새로고침했습니다.',
          'success',
        );
      }
    } catch (error) {
      optionsRef.current.notify(
        error instanceof Error ? error.message : '외부 소스에서 파일을 선택하지 못했습니다.',
        'danger',
      );
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [activeSourceId, busy, loadPage, query, refreshLocalProjection]);

  const removeItem = useCallback(
    async (item: ExternalSourceItemView) => {
      if (!activeSourceId || busy || !optionsRef.current.registry.removeExternalSourceItem) return;
      if (!optionsRef.current.registry.canRemoveExternalSourceItem?.(activeSourceId, optionsRef.current.hostContext)) {
        return;
      }
      if (
        !optionsRef.current.confirm(
          `${item.title}을(를) 이 소스의 선택 목록에서 제거할까요? 이미 라이브러리에 가져온 작품은 유지됩니다.`,
        )
      ) {
        return;
      }
      setBusy(true);
      try {
        await optionsRef.current.registry.removeExternalSourceItem(
          activeSourceId,
          optionsRef.current.hostContext,
          item.key,
        );
        setBrokerRevision((value) => value + 1);
        await loadPage({ query: query.trim() || undefined }, false, activeSourceId);
        optionsRef.current.notify('Google Drive 선택 목록에서 파일을 제거했습니다.', 'success');
      } catch (error) {
        optionsRef.current.notify(
          error instanceof Error ? error.message : '선택 목록에서 파일을 제거하지 못했습니다.',
          'danger',
        );
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    },
    [activeSourceId, busy, loadPage, query],
  );

  const persistLibraryWork = useCallback(
    async (input: {
      readonly sourceId: ExtensionContributionId;
      readonly accountConnectionId?: string;
      readonly navigationRef: string;
      readonly sourceNavigationRef?: string;
      readonly detail: ExternalSourceWorkDetail;
      readonly items: readonly ExternalItemSummary[];
      readonly baselineComplete: boolean;
      readonly signal?: AbortSignal;
    }) => {
      const existing = subscriptions.find(
        (record) =>
          record.connectorId === input.sourceId &&
          (record.accountConnectionId ?? '') === (input.accountConnectionId ?? '') &&
          record.collectionRemoteId === input.navigationRef,
      );
      if (existing) return existing;
      const now = currentIso();
      const releaseIds = input.items.filter((item) => item.release).map((item) => item.key.remoteId);
      const resolvedThumbnail = await resolveDetailThumbnail(
        input.detail,
        input.signal ?? new AbortController().signal,
      ).catch(() => undefined);
      const thumbnailUrl = await persistentThumbnailUrl(resolvedThumbnail);
      input.signal?.throwIfAborted();
      if (!mountedRef.current) throw new DOMException('Operation cancelled', 'AbortError');
      const record = {
        id: externalSourceSubscriptionId(input.sourceId, input.accountConnectionId, input.navigationRef),
        connectorId: input.sourceId,
        accountConnectionId: input.accountConnectionId,
        collectionRemoteId: input.navigationRef,
        navigationRef: input.navigationRef,
        sourceNavigationRef: input.sourceNavigationRef,
        title: input.detail.title,
        author: input.detail.author,
        description: input.detail.description,
        thumbnailUrl,
        sourceLabel: input.detail.sourceLabel,
        knownReleaseIds: releaseIds,
        newReleaseIds: [],
        releaseBaselineComplete: input.baselineComplete,
        availableReleaseCount: releaseIds.length,
        lastCheckedAt: now,
        createdAt: now,
        updatedAt: now,
        schemaVersion: 1,
      } satisfies ExternalSourceSubscriptionRecord;
      await optionsRef.current.state.saveSubscription(record);
      if (mountedRef.current) replaceSubscription(record);
      return record;
    },
    [replaceSubscription, subscriptions, resolveDetailThumbnail],
  );

  const addCurrentWorkToLibrary = useCallback(async () => {
    if (!activeSourceId || !currentParentRef || !detail || busy) return;
    const source = sources.find((candidate) => candidate.id === activeSourceId);
    if (!source?.supportsSubscriptions || source.connection.state !== 'connected') return;
    try {
      const record = await persistLibraryWork({
        sourceId: activeSourceId,
        accountConnectionId: source.connection.accountConnectionId,
        navigationRef: currentParentRef,
        sourceNavigationRef: breadcrumbs.at(-2)?.parentRef,
        detail,
        items: rawItems,
        baselineComplete: !nextCursor,
        signal: listAbortRef.current?.signal,
      });
      optionsRef.current.notify(
        `${record.title}을(를) 라이브러리에 추가했습니다. 회차는 선택할 때만 다운로드합니다.${
          record.releaseBaselineComplete ? '' : ' 일부 목록만 확인되어 새 회차 판단은 아직 완료되지 않았습니다.'
        }`,
        'success',
      );
    } catch (error) {
      optionsRef.current.notify(
        error instanceof Error ? error.message : '작품을 라이브러리에 추가하지 못했습니다.',
        'danger',
      );
    }
  }, [activeSourceId, breadcrumbs, busy, currentParentRef, detail, nextCursor, persistLibraryWork, rawItems, sources]);

  const addWorkToLibrary = useCallback(
    async (item: ExternalSourceItemView) => {
      if (busy || item.kind !== 'work' || !item.navigationRef) return;
      const sourceId = item.key.connectorId as ExtensionContributionId;
      const source = sources.find((candidate) => candidate.id === sourceId);
      if (!source?.supportsSubscriptions || source.connection.state !== 'connected') return;
      if (isWorkInLibrary(item)) {
        optionsRef.current.notify('이미 라이브러리에 추가한 작품입니다.');
        return;
      }
      const abort = new AbortController();
      subscriptionAbortRef.current?.abort();
      subscriptionAbortRef.current = abort;
      setBusy(true);
      try {
        const page = await optionsRef.current.registry.listExternalSource(
          sourceId,
          optionsRef.current.hostContext,
          {
            accountConnectionId: source.connection.accountConnectionId,
            parentRef: item.navigationRef,
          },
          abort.signal,
        );
        const record = await persistLibraryWork({
          sourceId,
          accountConnectionId: source.connection.accountConnectionId,
          navigationRef: item.navigationRef,
          sourceNavigationRef: currentParentRef,
          detail: page.detail ?? {
            title: item.title,
            author: item.author,
            description: item.collection?.description ?? item.subtitle,
            thumbnailUrl: item.thumbnailUrl,
            sourceLabel: item.collection?.sourceLabel,
          },
          items: page.items,
          baselineComplete: !page.nextCursor,
          signal: abort.signal,
        });
        optionsRef.current.notify(
          `${record.title}을(를) 라이브러리에 추가했습니다. 회차는 선택할 때만 다운로드합니다.${
            record.releaseBaselineComplete ? '' : ' 일부 목록만 확인되어 새 회차 판단은 아직 완료되지 않았습니다.'
          }`,
          'success',
        );
      } catch (error) {
        if (!isAbort(error)) {
          optionsRef.current.notify(
            error instanceof Error ? error.message : '작품을 라이브러리에 추가하지 못했습니다.',
            'danger',
          );
        }
      } finally {
        if (subscriptionAbortRef.current === abort) subscriptionAbortRef.current = undefined;
        if (mountedRef.current) setBusy(false);
      }
    },
    [busy, currentParentRef, isWorkInLibrary, persistLibraryWork, sources],
  );

  const removeLibraryWork = useCallback(
    async (subscription: ExternalSourceSubscriptionRecord) => {
      if (busy) return;
      if (
        !optionsRef.current.confirm(
          `${subscription.title}을(를) 라이브러리에서 제거할까요? 이미 받은 로컬 회차는 유지됩니다.`,
        )
      ) {
        return;
      }
      try {
        await optionsRef.current.state.deleteSubscription(subscription.id);
        if (!mountedRef.current) return;
        setSubscriptions((current) => current.filter((item) => item.id !== subscription.id));
        optionsRef.current.notify('원격 작품을 라이브러리에서 제거했습니다. 받아 둔 회차는 유지됩니다.', 'success');
      } catch (error) {
        optionsRef.current.notify(
          error instanceof Error ? error.message : '작품을 라이브러리에서 제거하지 못했습니다.',
          'danger',
        );
      }
    },
    [busy],
  );

  const subscribeCurrentWork = addCurrentWorkToLibrary;

  const unsubscribeCurrentWork = useCallback(async () => {
    if (activeSubscription) await removeLibraryWork(activeSubscription);
  }, [activeSubscription, removeLibraryWork]);

  const acknowledgeNewReleases = useCallback(async () => {
    if (!activeSubscription || activeSubscription.newReleaseIds.length === 0 || busy) return;
    const next = {
      ...activeSubscription,
      newReleaseIds: [],
      updatedAt: currentIso(),
    } satisfies ExternalSourceSubscriptionRecord;
    try {
      await optionsRef.current.state.saveSubscription(next);
      if (!mountedRef.current) return;
      replaceSubscription(next);
      optionsRef.current.notify('새 회차 표시를 확인 완료로 변경했습니다.', 'success');
    } catch (error) {
      optionsRef.current.notify(
        error instanceof Error ? error.message : '새 회차 상태를 저장하지 못했습니다.',
        'danger',
      );
    }
  }, [activeSubscription, busy, replaceSubscription]);

  const selectNewReleases = useCallback(() => {
    if (!activeSubscription || busy) return;
    const newIds = new Set(activeSubscription.newReleaseIds);
    setSelectedKeys(
      new Set(
        items
          .filter(
            (item) =>
              newIds.has(item.key.remoteId) &&
              item.kind !== 'folder' &&
              item.importState !== 'unsupported' &&
              item.importState !== 'imported',
          )
          .map((item) => externalItemKeyId(item.key)),
      ),
    );
  }, [activeSubscription, busy, items]);

  const checkSubscriptions = useCallback(async () => {
    if (!activeSourceId || checkingSubscriptions || busy) return;
    const source = sources.find((candidate) => candidate.id === activeSourceId);
    if (!source?.supportsSubscriptions || source.connection.state !== 'connected') return;
    const targets = subscriptions.filter(
      (item) =>
        item.connectorId === activeSourceId &&
        (item.accountConnectionId ?? '') === (source.connection.accountConnectionId ?? ''),
    );
    if (targets.length === 0) return;
    const checkScope = JSON.stringify([activeSourceId, source.connection.accountConnectionId ?? '']);
    const startOffset = (subscriptionCheckOffsetsRef.current.get(checkScope) ?? 0) % targets.length;
    const orderedTargets = [...targets.slice(startOffset), ...targets.slice(0, startOffset)];
    const abort = new AbortController();
    subscriptionAbortRef.current?.abort();
    subscriptionAbortRef.current = abort;
    setCheckingSubscriptions(true);
    let failed = 0;
    let checked = 0;
    let incomplete = 0;
    let remainingPages = MAX_SUBSCRIPTION_CHECK_TOTAL_PAGES;
    const isCurrent = () => {
      const current = optionsRef.current.registry.getExternalSourceStatus(
        activeSourceId,
        optionsRef.current.hostContext,
      );
      return (
        !abort.signal.aborted &&
        subscriptionAbortRef.current === abort &&
        current.state === 'connected' &&
        current.connectionGeneration === source.connection.connectionGeneration &&
        (current.accountConnectionId ?? '') === (source.connection.accountConnectionId ?? '')
      );
    };
    const previousNewCount = targets.reduce((total, item) => total + item.newReleaseIds.length, 0);
    try {
      for (const subscription of orderedTargets.slice(0, 50)) {
        if (!isCurrent() || remainingPages === 0) break;
        try {
          const page = await collectSubscriptionReleasePages({
            signal: abort.signal,
            takePageBudget: () => {
              if (remainingPages === 0) return false;
              remainingPages -= 1;
              return true;
            },
            readPage: (cursor, signal) => {
              if (!isCurrent()) throw new DOMException('Operation cancelled', 'AbortError');
              return optionsRef.current.registry.listExternalSource(
                activeSourceId,
                optionsRef.current.hostContext,
                {
                  accountConnectionId: source.connection.accountConnectionId,
                  parentRef: subscription.navigationRef,
                  cursor,
                },
                signal,
              );
            },
          });
          if (!isCurrent()) break;
          await reconcileSubscriptionPage(
            activeSourceId,
            source.connection.accountConnectionId,
            subscription.collectionRemoteId,
            page,
            page.complete,
            isCurrent,
          );
          checked += 1;
          if (!page.complete) incomplete += 1;
        } catch (error) {
          if (isAbort(error)) break;
          failed += 1;
        }
      }
      if (isCurrent())
        subscriptionCheckOffsetsRef.current.set(checkScope, (startOffset + checked + failed) % targets.length);
      const next = await optionsRef.current.state.listSubscriptions();
      if (!mountedRef.current || !isCurrent()) return;
      setSubscriptions(next);
      const nextNewCount = next
        .filter(
          (item) =>
            item.connectorId === activeSourceId &&
            (item.accountConnectionId ?? '') === (source.connection.accountConnectionId ?? ''),
        )
        .reduce((total, item) => total + item.newReleaseIds.length, 0);
      if (incomplete > 0 || targets.length > checked + failed) {
        optionsRef.current.notify(
          `일부 회차 목록만 확인했습니다. ${incomplete}개 작품의 새 회차 판단이 미완료이며 기존 표시는 유지됩니다.${
            targets.length > checked + failed
              ? ` 아직 확인하지 않은 작품 ${targets.length - checked - failed}개가 있습니다.`
              : ''
          }${failed ? ` ${failed}개 작품은 목록을 불러오지 못했습니다.` : ''}`,
          'warning',
        );
      } else if (failed > 0) {
        optionsRef.current.notify(
          `라이브러리 작품 ${checked}개를 확인했고 ${failed}개는 확인하지 못했습니다.`,
          'warning',
        );
      } else if (nextNewCount > previousNewCount) {
        optionsRef.current.notify(`새 회차 ${nextNewCount - previousNewCount}개를 찾았습니다.`, 'success');
      }
    } finally {
      if (subscriptionAbortRef.current === abort) subscriptionAbortRef.current = undefined;
      if (mountedRef.current) setCheckingSubscriptions(false);
    }
  }, [activeSourceId, busy, checkingSubscriptions, reconcileSubscriptionPage, sources, subscriptions]);

  const openSubscription = useCallback(
    async (subscription: ExternalSourceSubscriptionRecord) => {
      const sourceId = subscription.connectorId as ExtensionContributionId;
      if (blockingBusy || (importBusy && sourceId !== activeSourceId)) return;
      const source = sources.find((candidate) => candidate.id === sourceId);
      if (source?.connection.state !== 'connected') {
        optionsRef.current.notify('작품 소스에 다시 연결한 뒤 회차를 확인할 수 있습니다.', 'warning');
        return;
      }
      setLocalSeriesBookId(undefined);
      setLocalSeriesSeedNovel(undefined);
      setLocalSeriesSourceId(undefined);
      setLocalSeriesReadingStates(new Map());
      setLocalSeriesChapters([]);
      setActiveSourceId(sourceId);
      setOpen(true);
      setQuery('');
      setSelectedKeys(new Set());
      setBreadcrumbs([
        { label: '최상위 폴더' },
        ...(subscription.sourceNavigationRef
          ? [{ label: subscription.sourceLabel ?? 'Mihon 소스', parentRef: subscription.sourceNavigationRef }]
          : []),
        { label: subscription.title, parentRef: subscription.navigationRef },
      ]);
      await refreshLocalProjection();
      await loadPage({ parentRef: subscription.navigationRef }, false, sourceId);
    },
    [activeSourceId, blockingBusy, importBusy, loadPage, refreshLocalProjection, sources],
  );

  useEffect(() => {
    if (!open || loading || currentParentRef || detail || checkingSubscriptions || !activeSourceId) return;
    const source = sources.find((candidate) => candidate.id === activeSourceId);
    if (!source?.supportsSubscriptions || source.connection.state !== 'connected') return;
    if (
      !subscriptions.some(
        (item) =>
          item.connectorId === activeSourceId &&
          (item.accountConnectionId ?? '') === (source.connection.accountConnectionId ?? ''),
      )
    ) {
      return;
    }
    const key = `${activeSourceId}::${source.connection.accountConnectionId ?? ''}`;
    if (foregroundSubscriptionChecksRef.current.has(key)) return;
    foregroundSubscriptionChecksRef.current.add(key);
    void checkSubscriptions();
  }, [
    activeSourceId,
    checkSubscriptions,
    checkingSubscriptions,
    currentParentRef,
    detail,
    loading,
    open,
    sources,
    subscriptions,
  ]);

  const canPickItems = Boolean(
    activeSourceId && options.registry.canPickExternalSource?.(activeSourceId, options.hostContext),
  );
  const canRemoveItems = Boolean(
    activeSourceId && options.registry.canRemoveExternalSourceItem?.(activeSourceId, options.hostContext),
  );
  const canSubscribeCurrentWork = Boolean(
    activeSourceId &&
    currentParentRef &&
    detail &&
    sources.find((source) => source.id === activeSourceId)?.supportsSubscriptions &&
    sources.find((source) => source.id === activeSourceId)?.connection.state === 'connected',
  );
  const localSeriesNovel = localSeriesBookId
    ? (novels.find((novel) => novel.id === localSeriesBookId) ?? localSeriesSeedNovel)
    : undefined;

  return {
    open,
    loading,
    busy,
    blockingBusy,
    catalogLoading,
    catalogUpdateAvailable,
    applyCatalogUpdate,
    importBusy,
    selectedBatchActive,
    tasks,
    linkedSeriesBookIds,
    sources,
    activeSourceId,
    items,
    query,
    nextCursor,
    stale,
    listError: listFailure
      ? {
          message: listFailure.message,
          retry: async () => {
            await loadPage(listFailure.input, listFailure.append, listFailure.sourceId, true, true);
          },
        }
      : undefined,
    detail,
    localSeriesNovel,
    localSeriesSourceId,
    browse,
    filterValues,
    breadcrumbs,
    currentFolderIsDefault: Boolean(currentParentRef && defaultFolder?.parentRef === currentParentRef),
    currentLocationCanBeDefault: Boolean(
      currentParentRef && !detail && sources.find((source) => source.id === activeSourceId)?.kind === 'cloud_file',
    ),
    canPickItems,
    canRemoveItems,
    progress,
    subscriptions,
    libraryWorks,
    activeSubscription,
    checkingSubscriptions,
    canSubscribeCurrentWork,
    canQueueItem,
    isWorkInLibrary,
    addWorkToLibrary,
    addCurrentWorkToLibrary,
    removeLibraryWork,
    show,
    showLocalSeries,
    close,
    selectSource,
    setQuery,
    search,
    setBrowseMode,
    setFilterValue,
    applyFilters,
    resetFilters,
    refresh,
    loadMore,
    toggleItem,
    selectAllSupported,
    importItem,
    importAndOpen,
    importSelected,
    openImported,
    cancel,
    dismissTask,
    connect,
    disconnect,
    openItem,
    openFolder,
    goBack,
    setCurrentFolderAsDefault,
    clearDefaultFolder,
    pickItems,
    removeItem,
    subscribeCurrentWork,
    unsubscribeCurrentWork,
    acknowledgeNewReleases,
    selectNewReleases,
    checkSubscriptions,
    openSubscription,
  };
}
