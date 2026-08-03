import type { PlatformRuntimeInfo } from './runtime';
import { AndroidDocumentIo, type TauriInvoke } from './android/document-io';

export interface PickDocumentsOptions {
  readonly multiple?: boolean;
  readonly mimeTypes: readonly string[];
  readonly extensions: readonly string[];
}

export interface SaveDocumentInput {
  readonly suggestedName: string;
  readonly mimeType: string;
  readonly blob: Blob;
}

export type SaveDocumentResult = 'saved' | 'cancelled';

export interface PlatformDocumentIo {
  readonly usesNativePicker: boolean;
  readonly usesNativeSave: boolean;
  pickDocuments(options: PickDocumentsOptions): Promise<File[] | undefined>;
  saveDocument(input: SaveDocumentInput): Promise<SaveDocumentResult>;
}

export interface PlatformDocumentIoDependencies {
  readonly invoke?: TauriInvoke;
  readonly createObjectUrl?: (blob: Blob) => string;
  readonly revokeObjectUrl?: (url: string) => void;
  readonly triggerDownload?: (url: string, fileName: string) => void;
  readonly schedule?: (callback: () => void, delayMs: number) => void;
}

function safeSuggestedName(value: string): string {
  const normalized = Array.from(value.trim(), (character) =>
    character.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(character) ? '_' : character,
  ).join('');
  return normalized.slice(0, 180) || 'moya-export';
}

class BrowserDocumentIo implements PlatformDocumentIo {
  readonly usesNativePicker = false;
  readonly usesNativeSave = false;

  constructor(private readonly dependencies: PlatformDocumentIoDependencies) {}

  async pickDocuments(): Promise<undefined> {
    return undefined;
  }

  async saveDocument(input: SaveDocumentInput): Promise<SaveDocumentResult> {
    const createObjectUrl = this.dependencies.createObjectUrl ?? URL.createObjectURL;
    const revokeObjectUrl = this.dependencies.revokeObjectUrl ?? URL.revokeObjectURL;
    const triggerDownload =
      this.dependencies.triggerDownload ??
      ((url: string, fileName: string) => {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = fileName;
        anchor.click();
      });
    const schedule = this.dependencies.schedule ?? window.setTimeout.bind(window);
    const url = createObjectUrl(input.blob);
    triggerDownload(url, safeSuggestedName(input.suggestedName));
    schedule(() => revokeObjectUrl(url), 1_000);
    return 'saved';
  }
}

export function createPlatformDocumentIo(
  runtime: PlatformRuntimeInfo,
  dependencies: PlatformDocumentIoDependencies = {},
): PlatformDocumentIo {
  if (runtime.kind === 'tauri-mobile') return new AndroidDocumentIo(dependencies.invoke);
  return new BrowserDocumentIo(dependencies);
}
