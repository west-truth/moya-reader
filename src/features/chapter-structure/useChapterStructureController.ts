import { useCallback, useRef, useState } from 'react';
import type {
  ChapterStructureCommand,
  ChapterStructureEditorState,
  ChapterStructurePreview,
  ChapterStructureRepository,
} from '../../repositories/chapter-structure-repository';
import type { ToastTone } from '../../shared/ui/ToastHost';

export interface ChapterStructureController {
  readonly open: boolean;
  readonly busy: boolean;
  readonly available: boolean;
  readonly editor?: ChapterStructureEditorState;
  readonly preview?: ChapterStructurePreview;
  openPanel(bookId: string): Promise<void>;
  closePanel(): void;
  previewCommand(command: ChapterStructureCommand): Promise<void>;
  clearPreview(): void;
  applyPreview(): Promise<void>;
  rollbackLatest(): Promise<void>;
}

interface Options {
  readonly repository?: ChapterStructureRepository;
  readonly onApplied: (bookId: string) => Promise<void>;
  readonly notify: (message: string, tone?: ToastTone) => void;
}

export function useChapterStructureController(options: Options): ChapterStructureController {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const bookIdRef = useRef<string>();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<ChapterStructureEditorState>();
  const [preview, setPreview] = useState<ChapterStructurePreview>();

  const reload = useCallback(async (bookId: string) => {
    const repository = optionsRef.current.repository;
    if (!repository) return;
    setEditor(await repository.getEditorState(bookId));
  }, []);

  const openPanel = useCallback(
    async (bookId: string) => {
      const repository = optionsRef.current.repository;
      if (!repository || busy) {
        optionsRef.current.notify('이 실행 환경에서는 화 구조 편집을 지원하지 않습니다.', 'warning');
        return;
      }
      bookIdRef.current = bookId;
      setOpen(true);
      setBusy(true);
      setPreview(undefined);
      try {
        await reload(bookId);
      } catch (error) {
        setOpen(false);
        optionsRef.current.notify(error instanceof Error ? error.message : '화 구조를 불러오지 못했습니다.', 'danger');
      } finally {
        setBusy(false);
      }
    },
    [busy, reload],
  );

  const closePanel = useCallback(() => {
    if (busy) return;
    setOpen(false);
    setPreview(undefined);
  }, [busy]);

  const previewCommand = useCallback(
    async (command: ChapterStructureCommand) => {
      const repository = optionsRef.current.repository;
      const bookId = bookIdRef.current;
      if (!repository || !bookId || busy) return;
      setBusy(true);
      try {
        setPreview(await repository.preview(bookId, [command]));
      } catch (error) {
        optionsRef.current.notify(
          error instanceof Error ? error.message : '구조 변경을 미리 보지 못했습니다.',
          'danger',
        );
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  const applyPreview = useCallback(async () => {
    const repository = optionsRef.current.repository;
    const bookId = bookIdRef.current;
    if (!repository || !bookId || !preview || busy) return;
    setBusy(true);
    try {
      await repository.apply(preview.draftId);
      await optionsRef.current.onApplied(bookId);
      await reload(bookId);
      setPreview(undefined);
      optionsRef.current.notify('화 구조 변경을 적용했습니다.', 'success');
    } catch (error) {
      optionsRef.current.notify(error instanceof Error ? error.message : '화 구조를 적용하지 못했습니다.', 'danger');
    } finally {
      setBusy(false);
    }
  }, [busy, preview, reload]);

  const rollbackLatest = useCallback(async () => {
    const repository = optionsRef.current.repository;
    const bookId = bookIdRef.current;
    const receipt = editor?.latestReceipt;
    if (!repository || !bookId || !receipt || receipt.status !== 'active' || busy) return;
    setBusy(true);
    try {
      await repository.rollback(receipt.id);
      await optionsRef.current.onApplied(bookId);
      await reload(bookId);
      setPreview(undefined);
      optionsRef.current.notify('직전 화 구조 변경을 되돌렸습니다.', 'success');
    } catch (error) {
      optionsRef.current.notify(error instanceof Error ? error.message : '화 구조를 되돌리지 못했습니다.', 'danger');
    } finally {
      setBusy(false);
    }
  }, [busy, editor?.latestReceipt, reload]);

  return {
    open,
    busy,
    available: Boolean(options.repository),
    editor,
    preview,
    openPanel,
    closePanel,
    previewCommand,
    clearPreview: () => setPreview(undefined),
    applyPreview,
    rollbackLatest,
  };
}
