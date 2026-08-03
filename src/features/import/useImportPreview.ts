import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChapterSplitPreview } from '../../domain/parser';
import type { ChapterSplitMode, EncodingMode } from '../../domain/types';
import type {
  ChapterSplitPreviewController,
  ChapterSplitPreviewInput,
  ChapterSplitPreviewProgress,
} from '../../services/import/chapter-split-preview';

export interface ImportPreviewState {
  status: 'loading' | 'ready' | 'failed';
  fileName: string;
  encoding: EncodingMode;
  chapterSplitMode: ChapterSplitMode;
  result?: ChapterSplitPreview;
  message?: string;
  bytesRead?: number;
  totalBytes?: number;
}

export type ImportPreviewFactory = (
  input: ChapterSplitPreviewInput,
) => ChapterSplitPreviewController | Promise<ChapterSplitPreviewController>;

export interface ImportPreviewLifecycle {
  preview?: ImportPreviewState;
  start(file: File, encoding: EncodingMode, chapterSplitMode: ChapterSplitMode, blocked: boolean): Promise<void>;
  cancel(): void;
  clear(): void;
}

async function loadPreviewController(input: ChapterSplitPreviewInput): Promise<ChapterSplitPreviewController> {
  const { previewChapterSplit } = await import('../../services/import/chapter-split-preview');
  return previewChapterSplit(input);
}

export function useImportPreview(previewFactory?: ImportPreviewFactory): ImportPreviewLifecycle {
  const factoryRef = useRef(previewFactory);
  factoryRef.current = previewFactory;
  const [preview, setPreview] = useState<ImportPreviewState>();
  const previewRef = useRef(preview);
  previewRef.current = preview;
  const generationRef = useRef(0);
  const controllerRef = useRef<ChapterSplitPreviewController>();

  const cancel = useCallback(() => {
    generationRef.current += 1;
    controllerRef.current?.cancel();
    controllerRef.current = undefined;
  }, []);

  const clear = useCallback(() => {
    cancel();
    setPreview(undefined);
  }, [cancel]);

  useEffect(() => () => cancel(), [cancel]);

  const start = useCallback(
    async (file: File, encoding: EncodingMode, chapterSplitMode: ChapterSplitMode, blocked: boolean) => {
      if (blocked || previewRef.current?.status === 'loading') return;
      cancel();
      const generation = generationRef.current;
      setPreview({
        status: 'loading',
        fileName: file.name,
        encoding,
        chapterSplitMode,
        message: '화 분리 결과를 계산하는 중입니다.',
        bytesRead: 0,
        totalBytes: file.size,
      });

      try {
        const factory = factoryRef.current ?? loadPreviewController;
        const controller = await factory({
          file,
          encoding,
          chapterSplitMode,
          onProgress: (progress: ChapterSplitPreviewProgress) => {
            if (generationRef.current !== generation) return;
            setPreview((current) =>
              current?.status === 'loading'
                ? {
                    ...current,
                    bytesRead: progress.bytesRead,
                    totalBytes: progress.totalBytes,
                    message: progress.message,
                  }
                : current,
            );
          },
        });
        if (generationRef.current !== generation) {
          controller.cancel();
          return;
        }
        controllerRef.current = controller;
        const result = await controller.promise;
        if (generationRef.current !== generation) return;
        setPreview({
          status: 'ready',
          fileName: file.name,
          encoding,
          chapterSplitMode,
          result,
          bytesRead: file.size,
          totalBytes: file.size,
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        if (generationRef.current !== generation) return;
        setPreview({
          status: 'failed',
          fileName: file.name,
          encoding,
          chapterSplitMode,
          message: error instanceof Error ? error.message : '화 분리 미리보기에 실패했습니다.',
        });
      } finally {
        if (generationRef.current === generation) controllerRef.current = undefined;
      }
    },
    [cancel],
  );

  return { preview, start, cancel, clear };
}
