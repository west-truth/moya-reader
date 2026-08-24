import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ExtensionContributionId, ExternalSourceContributionDescriptor } from '@noveldesk/extension-contracts';
import { sha256 } from '../../domain/hash';
import type { Novel } from '../../domain/types';
import type {
  ExternalItemSummary,
  ExternalSourceConnectionForm,
  ExternalSourceConnectionInput,
  ExternalSourceConnectionStatus,
  ExternalSourceLink,
  ExternalSourceListInput,
  ExternalSourceWorkDetail,
  TrustedExternalSourceHostContext,
} from '../../external-sources/contracts';
import { externalItemKeyId, externalSourceLinkId } from '../../external-sources/contracts';
import type {
  ExternalSourceOrigin,
  ExternalSourceRegistryPort,
} from '../../external-sources/app-external-source-registry';
import {
  externalSourceDefaultFolderId,
  type ExternalSourceDefaultFolder,
  type ExternalSourceLocalState,
} from '../../external-sources/local-state';
import type { ImportController, ImportProgress, ImportService } from '../../services/import/import-service';
import type { ToastTone } from '../../shared/ui/ToastHost';

const CACHE_TTL_MS = 15 * 60 * 1_000;

export type { ExternalSourceRegistryPort } from '../../external-sources/app-external-source-registry';

export interface ExternalSourceView {
  readonly id: ExtensionContributionId;
  readonly title: string;
  readonly description?: string;
  readonly kind: ExternalSourceContributionDescriptor['kind'];
  readonly origin: ExternalSourceOrigin;
  readonly connection: ExternalSourceConnectionStatus;
  readonly connectionForm?: ExternalSourceConnectionForm;
}

export type ExternalSourceItemImportState = 'available' | 'imported' | 'update_available' | 'unsupported';

export interface ExternalSourceItemView extends ExternalItemSummary {
  readonly selected: boolean;
  readonly importState: ExternalSourceItemImportState;
  readonly localBookId?: string;
  readonly localBookTitle?: string;
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
  readonly breadcrumbs: readonly ExternalSourceBreadcrumb[];
  readonly currentFolderIsDefault: boolean;
  readonly currentLocationCanBeDefault: boolean;
  readonly canPickItems: boolean;
  readonly canRemoveItems: boolean;
  readonly progress?: ExternalSourceImportProgress;
  show(sourceId?: ExtensionContributionId): void;
  close(): void;
  selectSource(id: ExtensionContributionId): Promise<void>;
  setQuery(value: string): void;
  search(): Promise<void>;
  refresh(): Promise<void>;
  loadMore(): Promise<void>;
  toggleItem(key: string): void;
  selectAllSupported(selected: boolean): void;
  importItem(item: ExternalSourceItemView): Promise<void>;
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
}

export interface UseExternalSourceControllerOptions {
  readonly registry: ExternalSourceRegistryPort;
  readonly hostContext: TrustedExternalSourceHostContext;
  readonly state: ExternalSourceLocalState;
  readonly importService: ImportService;
  readonly extensionRevision: number;
  listNovels(): Promise<Novel[]>;
  getNovel(id: string): Promise<Novel | undefined>;
  openNovel(novel: Novel): void | Promise<void>;
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
    input.cursor ?? '',
  ].join('\u0000');
}

function queryFingerprint(input: ExternalSourceListInput): string {
  return JSON.stringify({ parentRef: input.parentRef ?? '', query: input.query?.trim() ?? '' });
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
  const [breadcrumbs, setBreadcrumbs] = useState<readonly ExternalSourceBreadcrumb[]>([{ label: '최상위 폴더' }]);
  const [defaultFolder, setDefaultFolder] = useState<ExternalSourceDefaultFolder>();
  const [progress, setProgress] = useState<ExternalSourceImportProgress>();
  const [brokerRevision, setBrokerRevision] = useState(0);
  const listAbortRef = useRef<AbortController>();
  const downloadAbortRef = useRef<AbortController>();
  const importRef = useRef<ImportController>();
  const mountedRef = useRef(true);

  const contributions = useMemo(() => {
    void options.extensionRevision;
    void brokerRevision;
    return options.registry.getExternalSources();
  }, [brokerRevision, options.extensionRevision, options.registry]);

  const sources = useMemo<readonly ExternalSourceView[]>(
    () =>
      contributions.map(({ descriptor, origin }) => ({
        id: descriptor.id,
        title: descriptor.title,
        description: descriptor.description,
        kind: descriptor.kind,
        origin: origin ?? 'plugin',
        connection: options.registry.getExternalSourceStatus(descriptor.id, options.hostContext),
        connectionForm: options.registry.getExternalSourceConnectionForm?.(descriptor.id, options.hostContext),
      })),
    [contributions, options.hostContext, options.registry],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      listAbortRef.current?.abort();
      downloadAbortRef.current?.abort();
      importRef.current?.cancel();
    };
  }, []);

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
      if (open && activeSource.connection.state !== 'connected') setOpen(false);
      return;
    }
    if (open) setOpen(false);
    setActiveSourceId(sources[0]?.id);
    setDefaultFolder(undefined);
  }, [activeSourceId, open, sources]);

  const currentParentRef = breadcrumbs.at(-1)?.parentRef;

  const refreshLocalProjection = useCallback(async (sourceId: string) => {
    const [nextLinks, nextNovels] = await Promise.all([
      optionsRef.current.state.listLinks(sourceId),
      optionsRef.current.listNovels(),
    ]);
    if (!mountedRef.current) return;
    setLinks(nextLinks);
    setNovels(nextNovels);
  }, []);

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
        const fetchedAt = currentIso();
        await optionsRef.current.state.saveCachePage({
          id,
          connectorId: sourceId,
          accountConnectionId: connection.accountConnectionId,
          queryFingerprint: queryFingerprint(normalizedInput),
          cursor: normalizedInput.cursor,
          nextCursor: page.nextCursor,
          items: page.items,
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
          setNextCursor(cached.nextCursor);
          setStale(true);
          optionsRef.current.notify('외부 저장소를 새로고치지 못해 마지막 목록을 표시합니다.', 'warning');
          return true;
        } else {
          setRawItems([]);
          if (!append) setDetail(undefined);
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
    [activeSourceId, busy, rawItems],
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
    await loadPage({ parentRef: currentParentRef, query: query.trim() || undefined }, false);
  }, [activeSourceId, currentParentRef, loadPage, query, refreshLocalProjection]);

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
  }, [busy]);

  const selectSource = useCallback(
    async (id: ExtensionContributionId) => {
      listAbortRef.current?.abort();
      setActiveSourceId(id);
      await loadSourceStart(id);
    },
    [loadSourceStart],
  );

  const search = useCallback(async () => {
    await loadPage({ parentRef: currentParentRef, query: query.trim() || undefined }, false);
  }, [currentParentRef, loadPage, query]);

  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    await loadPage({ parentRef: currentParentRef, query: query.trim() || undefined, cursor: nextCursor }, true);
  }, [currentParentRef, loadPage, nextCursor, query]);

  const linkByKey = useMemo(() => new Map(links.map((link) => [externalItemKeyId(link.source), link])), [links]);
  const novelById = useMemo(() => new Map(novels.map((novel) => [novel.id, novel])), [novels]);
  const items = useMemo<readonly ExternalSourceItemView[]>(
    () =>
      rawItems.map((item) => {
        const key = externalItemKeyId(item.key);
        const link = linkByKey.get(key);
        const localNovel = link ? novelById.get(link.localBookId) : undefined;
        const unsupported = item.kind === 'folder' || item.importability === 'unsupported';
        const changed = Boolean(
          link?.importedRemoteRevision && item.remoteRevision && link.importedRemoteRevision !== item.remoteRevision,
        );
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
        };
      }),
    [linkByKey, novelById, rawItems, selectedKeys],
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

  const importItems = useCallback(
    async (selected: readonly ExternalSourceItemView[]) => {
      const sourceId = activeSourceId;
      const importable = selected.filter(
        (item) => item.kind !== 'folder' && item.importState !== 'unsupported' && item.importState !== 'imported',
      );
      if (!sourceId || importable.length === 0 || busy) return;
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
              const controller = optionsRef.current.importService.importFile(
                {
                  file: downloaded.file,
                  encoding: 'auto',
                  chapterSplitMode: 'auto',
                  clientBookId: existingLink?.localBookId,
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
              importedNovel = (await optionsRef.current.getNovel(result.novel.id)) ?? result.novel;
              knownNovels.push(importedNovel);
              completed += 1;
              if (existingLink) updated += 1;
            } else {
              linkedExisting += 1;
            }
            if (!importedNovel) throw new Error('가져온 작품을 확인하지 못했습니다.');
            const linkedAt = currentIso();
            const link: ExternalSourceLink = {
              id: externalSourceLinkId(item.key),
              source: item.key,
              localBookId: importedNovel.id,
              importedRemoteRevision: downloaded.remoteRevision ?? item.remoteRevision,
              importedSourceContentHash: importedNovel.sourceContentHash ?? sourceHash,
              activeContentRevisionId: importedNovel.activeContentRevisionId,
              linkedAt: existingLink?.linkedAt ?? linkedAt,
              lastCheckedAt: linkedAt,
            };
            await optionsRef.current.state.saveLink(link);
            knownLinks.set(externalItemKeyId(item.key), link);
          } catch (error) {
            importRef.current = undefined;
            if (isAbort(error)) {
              cancelled = true;
              break;
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
        ]
          .filter((message): message is string => Boolean(message))
          .join(' ');
        optionsRef.current.notify(
          cancelled
            ? `${successMessage ? `${successMessage} ` : ''}가져오기를 취소했습니다. 취소된 작품은 기존 본문과 연결을 유지합니다.`
            : failed > 0
              ? `${successMessage ? `${successMessage} ` : ''}${failed}개는 적용하지 못해 기존 본문과 연결을 유지했습니다.${firstFailureMessage ? ` 첫 오류: ${firstFailureMessage}` : ''}`
              : successMessage || '선택한 작품에 적용할 변경 사항이 없습니다.',
          cancelled || failed > 0 ? 'warning' : 'success',
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
    [activeSourceId, busy, refreshLocalProjection],
  );

  const importItem = useCallback(
    async (item: ExternalSourceItemView) => {
      await importItems([item]);
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
      setOpen(false);
      await optionsRef.current.openNovel(novel);
    },
    [busy],
  );

  const cancel = useCallback(() => {
    listAbortRef.current?.abort();
    downloadAbortRef.current?.abort();
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
      await loadPage({ parentRef: item.navigationRef }, false);
    },
    [breadcrumbs, loadPage],
  );

  const openFolder = useCallback(
    async (item: ExternalSourceItemView) => {
      if (item.kind !== 'folder') return;
      await openItem(item);
    },
    [openItem],
  );

  const goBack = useCallback(async () => {
    if (breadcrumbs.length <= 1) return;
    const next = breadcrumbs.slice(0, -1);
    setBreadcrumbs(next);
    setSelectedKeys(new Set());
    await loadPage({ parentRef: next.at(-1)?.parentRef }, false);
  }, [breadcrumbs, loadPage]);

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

  const canPickItems = Boolean(
    activeSourceId && options.registry.canPickExternalSource?.(activeSourceId, options.hostContext),
  );
  const canRemoveItems = Boolean(
    activeSourceId && options.registry.canRemoveExternalSourceItem?.(activeSourceId, options.hostContext),
  );

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
    breadcrumbs,
    currentFolderIsDefault: Boolean(currentParentRef && defaultFolder?.parentRef === currentParentRef),
    currentLocationCanBeDefault: Boolean(
      currentParentRef && !detail && sources.find((source) => source.id === activeSourceId)?.kind === 'cloud_file',
    ),
    canPickItems,
    canRemoveItems,
    progress,
    show,
    close,
    selectSource,
    setQuery,
    search,
    refresh,
    loadMore,
    toggleItem,
    selectAllSupported,
    importItem,
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
  };
}
