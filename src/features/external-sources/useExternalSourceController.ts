import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ExtensionContributionId, ExternalSourceContributionDescriptor } from '@noveldesk/extension-contracts';
import { persistentId128 } from '@noveldesk/text-core/hash';
import { sha256 } from '../../domain/hash';
import type { Chapter, Novel } from '../../domain/types';
import type {
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
import type { BookAssetRepository } from '../../repositories/book-asset-repository';
import type { ToastTone } from '../../shared/ui/ToastHost';
import type { SuwayomiSeriesChapterInput } from '../../external-sources/suwayomi/suwayomi-series-cbz';
import {
  acquireExternalSourcePendingLinks,
  finalizeExternalSourceLinks,
  reconcilePendingExternalSourceLinks,
  restoreExternalSourceLinks,
  saveExternalSourceLinks,
} from '../../external-sources/link-import-reconciliation';
import {
  externalReleaseRevisionChanged,
  localSeriesDetail,
  projectLocalSeries,
  projectLocalSeriesReadingStates,
  type SerialReleaseReadingState,
} from './serial-work-projection';

const CACHE_TTL_MS = 15 * 60 * 1_000;
const MAX_SOURCE_COVER_BYTES = 8 * 1024 * 1024;

type SerialItemSummary = ExternalItemSummary & Required<Pick<ExternalItemSummary, 'collection' | 'release'>>;
type SerialSourceItem = ExternalSourceItemView & SerialItemSummary;

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
  readonly busy: boolean;
  readonly sources: readonly ExternalSourceView[];
  readonly activeSourceId?: ExtensionContributionId;
  readonly items: readonly ExternalSourceItemView[];
  readonly query: string;
  readonly nextCursor?: string;
  readonly stale: boolean;
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
  selectAllSupported(selected: boolean): void;
  importItem(item: ExternalSourceItemView): Promise<void>;
  importAndOpen(item: ExternalSourceItemView): Promise<void>;
  importSelected(): Promise<void>;
  openImported(item: ExternalSourceItemView): Promise<void>;
  cancel(): void;
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
  readonly extensionRevision: number;
  listNovels(): Promise<Novel[]>;
  listChapters(novelId: string): Promise<Chapter[]>;
  getNovel(id: string): Promise<Novel | undefined>;
  openNovel(novel: Novel, target?: { readonly documentSectionId?: string }): void | Promise<void>;
  onLibraryChanged(): Promise<void>;
  notify(message: string, tone?: ToastTone): void;
  confirm(message: string): boolean;
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

function sourceCoverContentType(value: string): 'image/jpeg' | 'image/png' | 'image/webp' | undefined {
  const normalized = value.split(';')[0]?.trim().toLocaleLowerCase();
  if (normalized === 'image/jpg' || normalized === 'image/jpeg') return 'image/jpeg';
  if (normalized === 'image/png') return 'image/png';
  if (normalized === 'image/webp') return 'image/webp';
  return undefined;
}

async function persistSourceCover(
  assets: BookAssetRepository | undefined,
  novel: Novel,
  thumbnailUrl: string | undefined,
): Promise<boolean> {
  if (!assets?.saveApprovedEnrichmentCover || !thumbnailUrl) return false;
  const active = await assets.getActiveCover(novel.id);
  if (
    active &&
    active.metadata.provenance !== 'archive_embedded' &&
    active.metadata.provenance !== 'generated_preview'
  ) {
    return false;
  }
  const response = await fetch(thumbnailUrl);
  if (!response.ok) throw new Error(`표지 요청에 실패했습니다. (HTTP ${response.status})`);
  const declaredLength = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_SOURCE_COVER_BYTES) {
    throw new Error('원격 표지 크기가 안전 한도를 초과했습니다.');
  }
  const blob = await response.blob();
  const contentType = sourceCoverContentType(blob.type || response.headers.get('Content-Type') || '');
  if (!contentType || blob.size === 0 || blob.size > MAX_SOURCE_COVER_BYTES) {
    throw new Error('지원하지 않는 원격 표지 형식입니다.');
  }
  const bitmap = await createImageBitmap(blob);
  const pixelWidth = bitmap.width;
  const pixelHeight = bitmap.height;
  bitmap.close();
  if (pixelWidth < 1 || pixelHeight < 1) throw new Error('원격 표지 크기를 확인하지 못했습니다.');
  const contentHash = await sha256(await blob.arrayBuffer());
  const extension = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg';
  await assets.saveApprovedEnrichmentCover(novel.id, {
    blob,
    fileName: `${novel.title}.${extension}`,
    contentType,
    contentHash,
    pixelWidth,
    pixelHeight,
    fit: 'crop',
    positionX: 50,
    positionY: 50,
    expectedMetadataRevision: novel.metadataRevision ?? 0,
  });
  return true;
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
  const [busy, setBusy] = useState(false);
  const [activeSourceId, setActiveSourceId] = useState<ExtensionContributionId>();
  const [rawItems, setRawItems] = useState<readonly ExternalItemSummary[]>([]);
  const [links, setLinks] = useState<readonly ExternalSourceLink[]>([]);
  const [novels, setNovels] = useState<readonly Novel[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [query, setQuery] = useState('');
  const [nextCursor, setNextCursor] = useState<string>();
  const [stale, setStale] = useState(false);
  const [detail, setDetail] = useState<ExternalSourceWorkDetail>();
  const [localSeriesBookId, setLocalSeriesBookId] = useState<string>();
  const [localSeriesSeedNovel, setLocalSeriesSeedNovel] = useState<Novel>();
  const [localSeriesSourceId, setLocalSeriesSourceId] = useState<ExtensionContributionId>();
  const [localSeriesReadingStates, setLocalSeriesReadingStates] = useState<
    ReadonlyMap<string, SerialReleaseReadingState>
  >(() => new Map());
  const [browse, setBrowse] = useState<ExternalSourceBrowseState>();
  const [filterValues, setFilterValues] = useState<Readonly<Record<string, ExternalSourceFilterValue>>>({});
  const [breadcrumbs, setBreadcrumbs] = useState<readonly ExternalSourceBreadcrumb[]>([{ label: '최상위 폴더' }]);
  const [defaultFolder, setDefaultFolder] = useState<ExternalSourceDefaultFolder>();
  const [progress, setProgress] = useState<ExternalSourceImportProgress>();
  const [subscriptions, setSubscriptions] = useState<readonly ExternalSourceSubscriptionRecord[]>([]);
  const [checkingSubscriptions, setCheckingSubscriptions] = useState(false);
  const [brokerRevision, setBrokerRevision] = useState(0);
  const listAbortRef = useRef<AbortController>();
  const downloadAbortRef = useRef<AbortController>();
  const subscriptionAbortRef = useRef<AbortController>();
  const foregroundSubscriptionChecksRef = useRef(new Set<string>());
  const importRef = useRef<ImportController>();
  const mountedRef = useRef(true);

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
    void Promise.all([
      optionsRef.current.state.listSubscriptions(),
      optionsRef.current.state.listLinks(),
      optionsRef.current.listNovels(),
    ])
      .then(async ([records, nextLinks, nextNovels]) => {
        if (!current || !mountedRef.current) return;
        const reconciledLinks = await reconcilePendingExternalSourceLinks(
          optionsRef.current.state,
          nextLinks,
          nextNovels,
        ).catch(() => nextLinks);
        if (!current || !mountedRef.current) return;
        setSubscriptions(records);
        setLinks(reconciledLinks);
        setNovels(nextNovels);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [options.extensionRevision]);

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

  const refreshLocalProjection = useCallback(async (sourceId: string) => {
    const [nextLinks, nextNovels] = await Promise.all([
      optionsRef.current.state.listLinks(sourceId),
      optionsRef.current.listNovels(),
    ]);
    if (!mountedRef.current) return;
    const reconciledLinks = await reconcilePendingExternalSourceLinks(
      optionsRef.current.state,
      nextLinks,
      nextNovels,
    ).catch(() => nextLinks);
    if (!mountedRef.current) return;
    setLinks(reconciledLinks);
    setNovels(nextNovels);
  }, []);

  const replaceSubscription = useCallback((next: ExternalSourceSubscriptionRecord) => {
    setSubscriptions((current) => [...current.filter((item) => item.id !== next.id), next]);
  }, []);

  const reconcileSubscriptionPage = useCallback(
    async (
      sourceId: string,
      accountConnectionId: string | undefined,
      parentRef: string | undefined,
      page: { readonly detail?: ExternalSourceWorkDetail; readonly items: readonly ExternalItemSummary[] },
    ) => {
      if (!parentRef || !page.detail) return;
      const id = externalSourceSubscriptionId(sourceId, accountConnectionId, parentRef);
      const current = (await optionsRef.current.state.listSubscriptions(sourceId, accountConnectionId)).find(
        (item) => item.id === id,
      );
      if (!current) return;
      const releaseIds = page.items.filter((item) => item.release).map((item) => item.key.remoteId);
      const known = new Set(current.knownReleaseIds);
      const previouslyNew = new Set(current.newReleaseIds);
      const thumbnailUrl = current.thumbnailUrl?.startsWith('data:')
        ? current.thumbnailUrl
        : await persistentThumbnailUrl(page.detail.thumbnailUrl);
      const next: ExternalSourceSubscriptionRecord = {
        ...current,
        title: page.detail.title,
        author: page.detail.author,
        description: page.detail.description,
        thumbnailUrl: thumbnailUrl ?? current.thumbnailUrl,
        sourceLabel: page.detail.sourceLabel,
        knownReleaseIds: [...new Set([...current.knownReleaseIds, ...releaseIds])],
        newReleaseIds: releaseIds.filter((releaseId) => previouslyNew.has(releaseId) || !known.has(releaseId)),
        availableReleaseCount: releaseIds.length,
        lastCheckedAt: currentIso(),
        updatedAt: currentIso(),
      };
      await optionsRef.current.state.saveSubscription(next);
      if (mountedRef.current) replaceSubscription(next);
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
    ): Promise<boolean | undefined> => {
      const sourceId = sourceOverride ?? activeSourceId;
      if (!sourceId || busy) return undefined;
      const connection = optionsRef.current.registry.getExternalSourceStatus(sourceId, optionsRef.current.hostContext);
      if (connection.state !== 'connected') {
        setRawItems([]);
        setDetail(undefined);
        setNextCursor(undefined);
        setStale(false);
        return false;
      }
      listAbortRef.current?.abort();
      const abort = new AbortController();
      listAbortRef.current = abort;
      setLoading(true);
      const normalizedInput: ExternalSourceListInput = {
        ...input,
        accountConnectionId: connection.accountConnectionId,
      };
      const id = cachePageId(sourceId, connection.accountConnectionId, normalizedInput);
      try {
        const page = await optionsRef.current.registry.listExternalSource(
          sourceId,
          optionsRef.current.hostContext,
          normalizedInput,
          abort.signal,
        );
        if (!mountedRef.current || abort.signal.aborted) return;
        setRawItems((current) => (append ? [...current, ...page.items] : page.items));
        if (!append) setDetail(page.detail);
        if (!append) {
          setBrowse(page.browse);
          if (page.browse?.filters) {
            setFilterValues((current) =>
              Object.keys(current).length > 0 ? current : defaultFilterValues(page.browse?.filters),
            );
          }
        }
        setSelectedKeys(
          (current) =>
            new Set(
              [...current].filter((key) =>
                (append ? [...rawItems, ...page.items] : page.items).some(
                  (item) => externalItemKeyId(item.key) === key,
                ),
              ),
            ),
        );
        setNextCursor(page.nextCursor);
        setStale(false);
        await reconcileSubscriptionPage(
          sourceId,
          connection.accountConnectionId,
          normalizedInput.parentRef,
          page,
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
          browse: page.browse,
          fetchedAt,
          expiresAt: new Date(Date.now() + CACHE_TTL_MS).toISOString(),
          schemaVersion: 1,
        });
        return true;
      } catch (error) {
        if (isAbort(error)) return undefined;
        const cached = await optionsRef.current.state.getCachePage(id);
        if (!mountedRef.current || abort.signal.aborted) return undefined;
        if (cached) {
          setRawItems((current) => (append ? [...current, ...cached.items] : cached.items));
          if (!append) setDetail(undefined);
          if (!append) {
            setBrowse(cached.browse);
            setFilterValues(defaultFilterValues(cached.browse?.filters));
          }
          setNextCursor(cached.nextCursor);
          setStale(true);
          optionsRef.current.notify('외부 저장소를 새로고치지 못해 마지막 목록을 표시합니다.', 'warning');
          return true;
        } else {
          setRawItems([]);
          if (!append) setDetail(undefined);
          if (!append) setBrowse(undefined);
          setNextCursor(undefined);
          setStale(false);
          if (notifyFailure) {
            optionsRef.current.notify(
              error instanceof Error ? error.message : '외부 저장소 목록을 불러오지 못했습니다.',
              'danger',
            );
          }
          return false;
        }
      } finally {
        if (mountedRef.current && listAbortRef.current === abort) setLoading(false);
      }
    },
    [activeSourceId, busy, rawItems, reconcileSubscriptionPage],
  );

  const loadSourceStart = useCallback(
    async (sourceId: ExtensionContributionId) => {
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
      await refreshLocalProjection(sourceId);
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
    await refreshLocalProjection(activeSourceId);
    await loadPage(
      {
        parentRef: currentParentRef,
        query: query.trim() || undefined,
        browseMode: query.trim() ? 'search' : browse?.activeMode,
        filters: filterChanges(browse?.filters, filterValues),
      },
      false,
    );
  }, [activeSourceId, browse, currentParentRef, filterValues, loadPage, query, refreshLocalProjection]);

  const show = useCallback(
    (requestedSourceId?: ExtensionContributionId) => {
      if (busy) return;
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
      setOpen(true);
      setActiveSourceId(sourceId);
      void loadSourceStart(sourceId);
    },
    [activeSourceId, busy, loadSourceStart, sources],
  );

  const close = useCallback(() => {
    if (busy) return;
    listAbortRef.current?.abort();
    setOpen(false);
    setLocalSeriesBookId(undefined);
    setLocalSeriesSeedNovel(undefined);
    setLocalSeriesSourceId(undefined);
    setLocalSeriesReadingStates(new Map());
  }, [busy]);

  const showLocalSeries = useCallback(
    async (novel: Novel) => {
      if (busy) return;
      listAbortRef.current?.abort();
      const [allLinks, chapters, nextNovels] = await Promise.all([
        optionsRef.current.state.listLinks(),
        optionsRef.current.listChapters(novel.id),
        optionsRef.current.listNovels(),
      ]);
      if (!mountedRef.current) return;
      const relatedLinks = allLinks.filter((link) => link.localBookId === novel.id && link.collectionRemoteId);
      const sourceId = relatedLinks[0]?.source.connectorId as ExtensionContributionId | undefined;
      const collectionRemoteId = relatedLinks[0]?.collectionRemoteId;
      const sourceLinks = sourceId ? allLinks.filter((link) => link.source.connectorId === sourceId) : relatedLinks;
      const local = projectLocalSeries(novel, chapters, sourceLinks);
      setLocalSeriesBookId(novel.id);
      setLocalSeriesSeedNovel(novel);
      setLocalSeriesSourceId(sourceId);
      setLocalSeriesReadingStates(projectLocalSeriesReadingStates(novel, chapters));
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
      if (!mountedRef.current) return;
      if (loaded === false) setRawItems(local.items);
      setDetail((current) => current ?? localSeriesDetail(novel));
    },
    [busy, loadPage, sources],
  );

  const selectSource = useCallback(
    async (id: ExtensionContributionId) => {
      listAbortRef.current?.abort();
      setLocalSeriesBookId(undefined);
      setLocalSeriesSeedNovel(undefined);
      setLocalSeriesSourceId(undefined);
      setLocalSeriesReadingStates(new Map());
      setActiveSourceId(id);
      await loadSourceStart(id);
    },
    [loadSourceStart],
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
  const items = useMemo<readonly ExternalSourceItemView[]>(
    () =>
      rawItems.map((item) => {
        const key = externalItemKeyId(item.key);
        const link = linkByKey.get(key);
        const localNovel = link ? novelById.get(link.localBookId) : undefined;
        const unsupported = item.kind === 'folder' || item.importability === 'unsupported';
        const changed = Boolean(link && externalReleaseRevisionChanged(item, link.importedRemoteRevision));
        return {
          ...item,
          selected: selectedKeys.has(key),
          importState: unsupported
            ? 'unsupported'
            : link && localNovel
              ? changed
                ? 'update_available'
                : 'imported'
              : 'available',
          localBookId: localNovel?.id,
          localBookTitle: localNovel?.title,
          readingState:
            item.release && localSeriesBookId
              ? (localSeriesReadingStates.get(item.key.remoteId) ?? 'unread')
              : undefined,
        };
      }),
    [linkByKey, localSeriesBookId, localSeriesReadingStates, novelById, rawItems, selectedKeys],
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
    return subscriptions.map((subscription) => {
      const related = links.find(
        (link) =>
          link.source.connectorId === subscription.connectorId &&
          (link.source.accountConnectionId ?? '') === (subscription.accountConnectionId ?? '') &&
          link.collectionRemoteId === subscription.collectionRemoteId &&
          knownNovelIds.has(link.localBookId),
      );
      return related ? { ...subscription, localBookId: related.localBookId } : subscription;
    });
  }, [links, novels, subscriptions]);

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
    (selected: boolean) => {
      setSelectedKeys(
        selected
          ? new Set(
              items
                .filter(
                  (item) =>
                    item.kind !== 'folder' && item.importState !== 'unsupported' && item.importState !== 'imported',
                )
                .map((item) => externalItemKeyId(item.key)),
            )
          : new Set(),
      );
    },
    [items],
  );

  const importSerialItems = useCallback(
    async (sourceId: ExtensionContributionId, importable: readonly SerialSourceItem[]): Promise<boolean> => {
      const collectionKeys = new Set(importable.map(serialCollectionKey));
      if (collectionKeys.size !== 1) return false;
      const collection = importable[0]!.collection;
      const selectedUpdateCount = importable.filter((item) => item.importState === 'update_available').length;
      if (
        selectedUpdateCount > 0 &&
        !optionsRef.current.confirm(
          `${selectedUpdateCount}개 회차의 원격 revision이 변경되었습니다. 실제 이미지가 달라진 회차만 기존 연재 작품 ID를 유지한 채 교체합니다. 실패하면 현재 작품과 연결은 유지됩니다. 계속할까요?`,
        )
      ) {
        return true;
      }

      setBusy(true);
      const abort = new AbortController();
      downloadAbortRef.current = abort;
      let importedNovel: Novel | undefined;
      let changedCount = 0;
      let revisionChecked = 0;
      let stagedLinks: readonly ExternalSourceLink[] = [];
      let previousLinks: readonly ExternalSourceLink[] = [];
      let contentApplied = false;
      try {
        const [knownNovels, knownLinks] = await Promise.all([
          optionsRef.current.listNovels(),
          optionsRef.current.state.listLinks(sourceId),
        ]);
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
        const existingNovel = existingLocalBookId
          ? knownNovels.find((novel) => novel.id === existingLocalBookId)
          : undefined;
        const existingSource = existingLocalBookId
          ? await optionsRef.current.assets?.exportSource(existingLocalBookId)
          : undefined;
        if (existingLocalBookId && !existingSource) {
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
                  (existingSource ? await sha256(await existingSource.blob.arrayBuffer()) : ''),
              }
            : undefined;

        const downloadedChapters: SuwayomiSeriesChapterInput[] = [];
        const checked = new Map<
          string,
          { item: SerialSourceItem; sourceHash: string; remoteRevision?: string; existingLink?: ExternalSourceLink }
        >();
        for (const [index, item] of importable.entries()) {
          abort.signal.throwIfAborted();
          setProgress({
            current: index + 1,
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
          setProgress((current) => (current ? { ...current, phase: 'verifying' } : current));
          const sourceHash = await sha256(await downloaded.file.arrayBuffer());
          const existingLink = knownLinks.find(
            (link) => externalItemKeyId(link.source) === externalItemKeyId(item.key),
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
            file: downloaded.file,
          });
          changedCount += 1;
        }

        if (downloadedChapters.length > 0) {
          setProgress({
            current: importable.length,
            total: importable.length,
            completed: 0,
            failed: 0,
            linkedExisting: revisionChecked,
            fileName: collection.title,
            phase: 'importing',
          });
          const { buildSuwayomiSeriesArchive } = await import('../../external-sources/suwayomi/suwayomi-series-cbz');
          const aggregate = await buildSuwayomiSeriesArchive({
            collection,
            chapters: downloadedChapters,
            existingArchive: existingSource?.blob,
            existingLegacyChapter,
            signal: abort.signal,
          });
          const expectedActiveSourceContentHash = await hashBlobInChunks(aggregate, {
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
                  expectedActiveSourceContentHash,
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
                expectedActiveSourceContentHash,
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
            },
            (progressDetail) => {
              if (!mountedRef.current) return;
              setProgress({
                current: importable.length,
                total: importable.length,
                completed: 0,
                failed: 0,
                linkedExisting: revisionChecked,
                fileName: collection.title,
                phase: 'importing',
                detail: progressDetail,
              });
            },
          );
          importRef.current = controller;
          const result = await controller.promise;
          importRef.current = undefined;
          contentApplied = true;
          importedNovel = (await optionsRef.current.getNovel(result.novel.id).catch(() => undefined)) ?? result.novel;
        } else {
          importedNovel = existingNovel;
        }
        if (!importedNovel) throw new Error('가져온 연재 작품을 확인하지 못했습니다.');

        const linkedAt = currentIso();
        let nextLinks: readonly ExternalSourceLink[];
        if (stagedLinks.length > 0) {
          nextLinks = await finalizeExternalSourceLinks(optionsRef.current.state, stagedLinks, importedNovel);
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

        if (downloadedChapters.length > 0) {
          await persistSourceCover(optionsRef.current.assets, importedNovel, detail?.thumbnailUrl).catch(() => false);
        }
        await optionsRef.current.onLibraryChanged();
        await refreshLocalProjection(sourceId);
        setSelectedKeys(new Set());
        optionsRef.current.notify(
          downloadedChapters.length > 0
            ? `${collection.title}에 ${downloadedChapters.length}개 회차를 추가하거나 갱신했습니다.${revisionChecked > 0 ? ` ${revisionChecked}개 회차는 원문이 같아 연결 revision만 갱신했습니다.` : ''}`
            : `${revisionChecked}개 회차는 원문이 같아 연결 revision만 갱신했습니다.`,
          'success',
        );
      } catch (error) {
        importRef.current = undefined;
        if (!contentApplied && stagedLinks.length > 0) {
          await restoreExternalSourceLinks(optionsRef.current.state, stagedLinks, previousLinks).catch(() => undefined);
        }
        optionsRef.current.notify(
          contentApplied
            ? `연재 본문 적용은 완료했으며 소스 연결은 다음 새로고침에서 복구합니다. ${
                error instanceof Error ? error.message : String(error || '')
              }`.trim()
            : isAbort(error)
              ? '가져오기를 취소했습니다. 기존 연재 작품과 연결은 유지됩니다.'
              : `연재 작품을 적용하지 못해 기존 본문과 연결을 유지했습니다. ${
                  error instanceof Error ? error.message : String(error || '')
                }`.trim(),
          'warning',
        );
      } finally {
        downloadAbortRef.current = undefined;
        importRef.current = undefined;
        if (mountedRef.current) {
          setBusy(false);
          setProgress(undefined);
        }
      }
      return true;
    },
    [acknowledgeImportedReleaseIds, detail?.thumbnailUrl, rawItems, refreshLocalProjection],
  );

  const importItems = useCallback(
    async (selected: readonly ExternalSourceItemView[]) => {
      const sourceId = activeSourceId;
      const importable = selected.filter(
        (item) => item.kind !== 'folder' && item.importState !== 'unsupported' && item.importState !== 'imported',
      );
      if (!sourceId || importable.length === 0 || busy) return;
      const serialItems = importable.filter((item): item is SerialSourceItem => isSerialSourceItem(item));
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
      setBusy(true);
      let completed = 0;
      let failed = 0;
      let linkedExisting = 0;
      let updated = 0;
      let revisionChecked = 0;
      let linkRepairPending = 0;
      let cancelled = false;
      let firstFailureMessage: string | undefined;
      setProgress({ current: 0, total: importable.length, completed, failed, linkedExisting });
      const knownNovels = await optionsRef.current.listNovels();
      const knownLinks = new Map(
        (await optionsRef.current.state.listLinks(sourceId)).map((link) => [externalItemKeyId(link.source), link]),
      );
      try {
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
            const sourceHash = await sha256(await downloaded.file.arrayBuffer());
            const existingLink = knownLinks.get(externalItemKeyId(item.key));
            let target = existingLink ? knownNovels.find((novel) => novel.id === existingLink.localBookId) : undefined;
            if (!target) {
              target = knownNovels.find(
                (novel) =>
                  normalizedHash(novel.sourceContentHash) === sourceHash ||
                  normalizedHash(novel.rawTextHash) === sourceHash,
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
        await refreshLocalProjection(sourceId);
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
      } finally {
        downloadAbortRef.current = undefined;
        importRef.current = undefined;
        if (mountedRef.current) {
          setBusy(false);
          setProgress(undefined);
        }
      }
    },
    [activeSourceId, busy, importSerialItems, refreshLocalProjection],
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
      const link = (await optionsRef.current.state.listLinks(item.key.connectorId)).find(
        (candidate) => externalItemKeyId(candidate.source) === externalItemKeyId(item.key),
      );
      if (!link) return;
      const novel = await optionsRef.current.getNovel(link.localBookId);
      if (!novel) return;
      setLocalSeriesBookId(novel.id);
      setLocalSeriesSeedNovel(novel);
      setLocalSeriesSourceId(item.key.connectorId as ExtensionContributionId);
      setOpen(false);
      await optionsRef.current.openNovel(novel, { documentSectionId: item.key.remoteId });
    },
    [importItems],
  );

  const importSelected = useCallback(async () => {
    await importItems(items.filter((item) => item.selected));
  }, [importItems, items]);

  const openImported = useCallback(
    async (item: ExternalSourceItemView) => {
      if (busy || item.importState !== 'imported' || !item.localBookId) return;
      const novel = await optionsRef.current.getNovel(item.localBookId);
      if (!novel) {
        optionsRef.current.notify('연결된 책장 작품을 찾지 못했습니다. 소스 목록을 새로고침해 주세요.', 'warning');
        return;
      }
      if (item.release) {
        setLocalSeriesBookId(novel.id);
        setLocalSeriesSeedNovel(novel);
        setLocalSeriesSourceId(item.key.connectorId as ExtensionContributionId);
      } else {
        setLocalSeriesBookId(undefined);
        setLocalSeriesSeedNovel(undefined);
        setLocalSeriesSourceId(undefined);
        setLocalSeriesReadingStates(new Map());
      }
      setOpen(false);
      if (item.release) await optionsRef.current.openNovel(novel, { documentSectionId: item.key.remoteId });
      else await optionsRef.current.openNovel(novel);
    },
    [busy],
  );

  const cancel = useCallback(() => {
    listAbortRef.current?.abort();
    downloadAbortRef.current?.abort();
    subscriptionAbortRef.current?.abort();
    importRef.current?.cancel();
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
      setRawItems([]);
      setDetail(undefined);
      setBrowse(undefined);
      setFilterValues({});
      setLinks([]);
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
  }, [activeSourceId, busy]);

  const openItem = useCallback(
    async (item: ExternalSourceItemView) => {
      if (!item.navigationRef || (item.kind !== 'folder' && item.kind !== 'work')) return;
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
    },
    [activeSourceId, breadcrumbs, loadPage, sources],
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
      await refreshLocalProjection(activeSourceId);
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
      const thumbnailUrl = await persistentThumbnailUrl(input.detail.thumbnailUrl);
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
    [replaceSubscription, subscriptions],
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
      });
      optionsRef.current.notify(
        `${record.title}을(를) 라이브러리에 추가했습니다. 회차는 선택할 때만 다운로드합니다.`,
        'success',
      );
    } catch (error) {
      optionsRef.current.notify(
        error instanceof Error ? error.message : '작품을 라이브러리에 추가하지 못했습니다.',
        'danger',
      );
    }
  }, [activeSourceId, breadcrumbs, busy, currentParentRef, detail, persistLibraryWork, rawItems, sources]);

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
        });
        optionsRef.current.notify(
          `${record.title}을(를) 라이브러리에 추가했습니다. 회차는 선택할 때만 다운로드합니다.`,
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
    const abort = new AbortController();
    subscriptionAbortRef.current?.abort();
    subscriptionAbortRef.current = abort;
    setCheckingSubscriptions(true);
    let failed = 0;
    const previousNewCount = targets.reduce((total, item) => total + item.newReleaseIds.length, 0);
    try {
      for (const subscription of targets.slice(0, 50)) {
        if (abort.signal.aborted) break;
        try {
          const page = await optionsRef.current.registry.listExternalSource(
            activeSourceId,
            optionsRef.current.hostContext,
            {
              accountConnectionId: source.connection.accountConnectionId,
              parentRef: subscription.navigationRef,
            },
            abort.signal,
          );
          await reconcileSubscriptionPage(
            activeSourceId,
            source.connection.accountConnectionId,
            subscription.collectionRemoteId,
            page,
          );
        } catch (error) {
          if (isAbort(error)) break;
          failed += 1;
        }
      }
      const next = await optionsRef.current.state.listSubscriptions();
      if (!mountedRef.current || abort.signal.aborted) return;
      setSubscriptions(next);
      const nextNewCount = next
        .filter((item) => item.connectorId === activeSourceId)
        .reduce((total, item) => total + item.newReleaseIds.length, 0);
      if (failed > 0) {
        optionsRef.current.notify(
          `라이브러리 작품 ${targets.length - failed}개를 확인했고 ${failed}개는 확인하지 못했습니다.`,
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
      if (busy) return;
      const sourceId = subscription.connectorId as ExtensionContributionId;
      const source = sources.find((candidate) => candidate.id === sourceId);
      if (source?.connection.state !== 'connected') {
        optionsRef.current.notify('작품 소스에 다시 연결한 뒤 회차를 확인할 수 있습니다.', 'warning');
        return;
      }
      setLocalSeriesBookId(undefined);
      setLocalSeriesSeedNovel(undefined);
      setLocalSeriesSourceId(undefined);
      setLocalSeriesReadingStates(new Map());
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
      await refreshLocalProjection(sourceId);
      await loadPage({ parentRef: subscription.navigationRef }, false, sourceId);
    },
    [busy, loadPage, refreshLocalProjection, sources],
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
    sources,
    activeSourceId,
    items,
    query,
    nextCursor,
    stale,
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
