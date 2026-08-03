import type { ToastTone } from '../../shared/ui/ToastHost';
import { formatCount } from '../../utils/format';
import type { ImportBatchOutcome } from './import-controller';
import { formatImportBytes } from './import-formatting';

export const LOCAL_IMPORT_TARGET_BYTES = 20 * 1024 * 1024;

export interface ImportNotice {
  message: string;
  tone: ToastTone;
}

export interface ImportFileSelection {
  supportedFiles: File[];
  skipped: number;
  notice?: ImportNotice;
}

export function isSupportedImportFile(file: File): boolean {
  return /\.(txt|md|markdown|epub|pdf|zip|cbz|rar|cbr|7z|cb7)$/i.test(file.name);
}

export function selectSupportedImportFiles(files: readonly File[]): ImportFileSelection {
  const supportedFiles = files.filter(isSupportedImportFile);
  const skipped = files.length - supportedFiles.length;
  if (supportedFiles.length === 0) {
    return {
      supportedFiles,
      skipped,
      notice: {
        message: 'TXT, Markdown, DRM 없는 EPUB, PDF 또는 이미지 ZIP/CBZ/RAR/CBR/7z/CB7 파일을 선택해 주세요.',
        tone: 'warning',
      },
    };
  }
  return {
    supportedFiles,
    skipped,
    notice:
      skipped > 0
        ? { message: `${formatCount(skipped)}개 파일은 지원하지 않아 건너뜁니다.`, tone: 'warning' }
        : undefined,
  };
}

export function oversizedImportNotice(files: readonly File[]): ImportNotice | undefined {
  const oversizedFiles = files.filter(
    (file) => file.size > LOCAL_IMPORT_TARGET_BYTES && /\.(txt|md|markdown)$/i.test(file.name),
  );
  if (oversizedFiles.length === 1) {
    return {
      message: `${formatImportBytes(oversizedFiles[0].size)} 텍스트 파일입니다. 20MB를 넘으면 분석과 저장에 시간이 걸릴 수 있습니다.`,
      tone: 'warning',
    };
  }
  if (oversizedFiles.length > 1) {
    return {
      message: `${formatCount(oversizedFiles.length)}개 파일이 20MB를 넘습니다. 순차 처리하므로 시간이 걸릴 수 있습니다.`,
      tone: 'warning',
    };
  }
  return undefined;
}

export function completedImportNotice(outcome: ImportBatchOutcome, files: readonly File[]): ImportNotice {
  if (outcome.aborted) {
    return {
      message:
        outcome.completed > 0
          ? `${formatCount(outcome.completed)}권을 가져온 뒤 중단했습니다.`
          : '가져오기를 취소했습니다.',
      tone: 'info',
    };
  }
  if (outcome.failed > 0) {
    return {
      message: `${formatCount(outcome.completed)}권 가져오기 완료, ${formatCount(outcome.failed)}권 실패`,
      tone: outcome.completed > 0 ? 'warning' : 'danger',
    };
  }
  return {
    message:
      files.length === 1
        ? `"${outcome.lastImportedNovel?.title ?? files[0].name}"을(를) 책장에 추가했습니다.`
        : `${formatCount(outcome.completed)}권을 책장에 추가했습니다.`,
    tone: 'success',
  };
}
