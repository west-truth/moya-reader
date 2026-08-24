import type { DrivePickerElement } from '@googleworkspace/drive-picker-element';

export const GOOGLE_DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file' as const;

export const GOOGLE_DRIVE_PICKER_MIME_TYPES = [
  'text/plain',
  'text/markdown',
  'application/pdf',
  'application/epub+zip',
  'application/zip',
  'application/x-zip-compressed',
  'application/vnd.comicbook+zip',
  'application/vnd.comicbook-rar',
  'application/x-rar-compressed',
  'application/vnd.rar',
  'application/x-7z-compressed',
].join(',');

export interface GoogleDrivePickerToken {
  readonly accessToken: string;
  readonly expiresInSeconds: number;
}

export interface GoogleDrivePickedDocument {
  readonly id: string;
  readonly name: string;
  readonly mimeType?: string;
  readonly sizeBytes?: number;
}

export interface GoogleDrivePickerRequest {
  readonly clientId: string;
  readonly appId: string;
  readonly developerKey: string;
  readonly accessToken?: string;
  readonly onToken: (token: GoogleDrivePickerToken) => Promise<void>;
}

export interface GoogleDrivePickerPort {
  open(request: GoogleDrivePickerRequest): Promise<readonly GoogleDrivePickedDocument[]>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function pickedDocuments(value: unknown): GoogleDrivePickedDocument[] {
  const docs = record(value)?.docs;
  if (!Array.isArray(docs)) return [];
  return docs.flatMap((candidate) => {
    const doc = record(candidate);
    const id = typeof doc?.id === 'string' ? doc.id.trim() : '';
    const name = typeof doc?.name === 'string' ? doc.name.trim() : '';
    if (!id || !name) return [];
    const rawSize = doc?.sizeBytes;
    const sizeBytes =
      typeof rawSize === 'number' && Number.isFinite(rawSize)
        ? rawSize
        : typeof rawSize === 'string' && /^\d+$/.test(rawSize)
          ? Number(rawSize)
          : undefined;
    return [
      {
        id,
        name,
        mimeType: typeof doc?.mimeType === 'string' ? doc.mimeType : undefined,
        sizeBytes,
      },
    ];
  });
}

export class GoogleDriveWebPicker implements GoogleDrivePickerPort {
  async open(request: GoogleDrivePickerRequest): Promise<readonly GoogleDrivePickedDocument[]> {
    if (typeof document === 'undefined' || typeof window === 'undefined') {
      throw new Error('Google Drive 파일 선택은 Web 화면에서만 사용할 수 있습니다.');
    }
    await import('@googleworkspace/drive-picker-element');

    return new Promise((resolve, reject) => {
      const picker = document.createElement('drive-picker') as DrivePickerElement;
      const view = document.createElement('drive-picker-docs-view');
      let settled = false;
      let tokenTask: Promise<void> = Promise.resolve();

      const cleanup = () => {
        picker.removeEventListener('picker-oauth-response', onOauthResponse);
        picker.removeEventListener('picker-oauth-error', onOauthError);
        picker.removeEventListener('picker-picked', onPicked);
        picker.removeEventListener('picker-canceled', onCanceled);
        picker.removeEventListener('picker-error', onPickerError);
        picker.remove();
      };
      const finish = (documents?: readonly GoogleDrivePickedDocument[], error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(documents ?? []);
      };
      const awaitToken = async () => {
        try {
          await tokenTask;
          return true;
        } catch {
          finish(undefined, new Error('Google Drive 연결 정보를 이 기기에 저장하지 못했습니다.'));
          return false;
        }
      };
      const onOauthResponse = (event: Event) => {
        const detail = record((event as CustomEvent<unknown>).detail);
        const accessToken = typeof detail?.access_token === 'string' ? detail.access_token.trim() : '';
        const rawExpiresIn = detail?.expires_in;
        const expiresInSeconds =
          typeof rawExpiresIn === 'number'
            ? rawExpiresIn
            : typeof rawExpiresIn === 'string'
              ? Number(rawExpiresIn)
              : Number.NaN;
        if (!accessToken || !Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
          finish(undefined, new Error('Google Drive 인증 응답을 확인하지 못했습니다.'));
          return;
        }
        tokenTask = request.onToken({ accessToken, expiresInSeconds });
        void tokenTask.catch(() => undefined);
      };
      const onOauthError = () => finish(undefined, new Error('Google Drive 계정 연결을 완료하지 못했습니다.'));
      const onPicked = (event: Event) => {
        void (async () => {
          if (!(await awaitToken())) return;
          finish(pickedDocuments((event as CustomEvent<unknown>).detail));
        })();
      };
      const onCanceled = () => {
        void (async () => {
          if (!(await awaitToken())) return;
          finish([]);
        })();
      };
      const onPickerError = () => finish(undefined, new Error('Google Drive 파일 선택기를 열지 못했습니다.'));

      picker.addEventListener('picker-oauth-response', onOauthResponse);
      picker.addEventListener('picker-oauth-error', onOauthError);
      picker.addEventListener('picker-picked', onPicked);
      picker.addEventListener('picker-canceled', onCanceled);
      picker.addEventListener('picker-error', onPickerError);
      picker.setAttribute('client-id', request.clientId);
      picker.setAttribute('app-id', request.appId);
      picker.setAttribute('developer-key', request.developerKey);
      picker.setAttribute('origin', window.location.origin);
      picker.setAttribute('locale', 'ko');
      picker.setAttribute('scope', GOOGLE_DRIVE_FILE_SCOPE);
      picker.setAttribute('title', '모야에 연결할 파일 선택');
      picker.setAttribute('max-items', '50');
      picker.setAttribute('multiselect', 'true');
      picker.setAttribute('prompt', '');
      if (request.accessToken) picker.setAttribute('oauth-token', request.accessToken);

      view.setAttribute('view-id', 'DOCS');
      view.setAttribute('include-folders', 'true');
      view.setAttribute('select-folder-enabled', 'false');
      view.setAttribute('mime-types', GOOGLE_DRIVE_PICKER_MIME_TYPES);
      picker.append(view);
      picker.style.display = 'none';
      document.body.append(picker);
    });
  }
}
