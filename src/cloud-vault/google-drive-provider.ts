import { CLOUD_VAULT_FILE_NAME, CloudVaultWriteConflictError, type CloudVaultContentProvider } from './contracts';

const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const CONDITIONAL_API = 'https://www.googleapis.com/drive/v2/files';
const CONDITIONAL_UPLOAD = 'https://www.googleapis.com/upload/drive/v2/files';
const NAMESPACE = 'moya-cloud-vault-v1';
const FOLDER = 'application/vnd.google-apps.folder';
const CHUNK = 8 * 1024 * 1024;
const MANIFEST_LIMIT = 16 * 1024 * 1024;
interface DriveFile {
  id: string;
  name: string;
  size?: string;
  version?: string;
  mimeType?: string;
  trashed?: boolean;
}
export interface GoogleDriveTokenSource {
  getAccessToken(): Promise<string>;
  invalidate(): void;
}
function safeId(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,256}$/.test(value)) throw new Error('Drive 파일 식별자가 올바르지 않습니다.');
  return value;
}
function safeKey(key: string): string {
  if (!/^(content|ai-tts)\/v1\/sha256\/[a-f0-9]{64}$/.test(key)) throw new Error('Cloud Vault object key is invalid.');
  return key;
}

/** Dedicated app-created folder; never edits Picker source files. All mutable writes require a strong ETag. */
export class GoogleDriveCloudVaultProvider implements CloudVaultContentProvider {
  readonly kind = 'google-drive' as const;
  readonly label = 'Google Drive';
  private folderId?: string;
  constructor(
    private readonly tokens: GoogleDriveTokenSource,
    private readonly fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args),
  ) {}

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    const target = new URL(url);
    if (
      target.origin !== 'https://www.googleapis.com' ||
      !/^\/(upload\/)?drive\/v[23]\/files(?:\/|$)/.test(target.pathname)
    ) {
      throw new Error('Drive 업로드 주소를 확인하지 못했습니다.');
    }
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${await this.tokens.getAccessToken()}`);
    const response = await this.fetchImpl(url, { ...init, headers, cache: 'no-store', redirect: 'error' });
    if (response.status === 401) {
      this.tokens.invalidate();
      throw new Error('Google Drive 연결이 만료됐습니다. 다시 연결하세요.');
    }
    if (response.status === 409 || response.status === 412) throw new CloudVaultWriteConflictError();
    if (![200, 201, 204, 308, 404].includes(response.status)) {
      throw new Error(
        response.status === 403
          ? 'Drive 권한 또는 저장 공간을 확인하세요. 다시 연결이 필요할 수 있습니다.'
          : `Google Drive 요청을 완료하지 못했습니다 (${response.status}).`,
      );
    }
    return response;
  }

  private async find(key: string, parent?: string): Promise<DriveFile | undefined> {
    const q = `trashed = false and appProperties has { key='moyaVault' and value='${NAMESPACE}' } and appProperties has { key='moyaObject' and value='${key}' }${parent ? ` and '${safeId(parent)}' in parents` : ''}`;
    const response = await this.request(
      `${API}?${new URLSearchParams({ q, spaces: 'drive', pageSize: '100', fields: 'files(id,name,size,mimeType),nextPageToken,incompleteSearch' })}`,
    );
    if (!response.ok) throw new Error('Drive 저장 위치를 확인하지 못했습니다.');
    const page = (await response.json()) as { files?: DriveFile[]; nextPageToken?: string; incompleteSearch?: boolean };
    if (!Array.isArray(page.files) || page.nextPageToken || page.incompleteSearch)
      throw new Error('Drive 파일 목록이 불완전합니다. 다시 시도하세요.');
    // Two simultaneous first connections can create duplicates: preserve both and stop, never silently pick a winner.
    if (page.files.length > 1)
      throw new Error('Drive에 중복된 모야 동기화 파일이 있습니다. 파일을 보존한 상태로 연결을 중단했습니다.');
    const file = page.files[0];
    if (file) safeId(file.id);
    return file;
  }

  private async folder(create: boolean): Promise<string | undefined> {
    // Resolve every operation so a trashed folder or a concurrent duplicate cannot be silently recreated/overwritten.
    const existing = await this.find('root');
    if (existing) {
      if (existing.mimeType !== FOLDER) throw new Error('모야 동기화 폴더가 올바르지 않습니다.');
      this.folderId = existing.id;
      return existing.id;
    }
    if (this.folderId) throw new Error('Drive 동기화 폴더가 이동되거나 삭제됐습니다. 연결을 확인하세요.');
    if (!create) return undefined;
    const response = await this.request(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Moya Sync',
        mimeType: FOLDER,
        appProperties: { moyaVault: NAMESPACE, moyaObject: 'root' },
      }),
    });
    if (!response.ok) throw new Error('Drive 동기화 폴더를 만들지 못했습니다.');
    const created = (await response.json()) as DriveFile;
    const found = await this.find('root');
    if (!found || found.id !== created.id) throw new CloudVaultWriteConflictError();
    this.folderId = safeId(created.id);
    return this.folderId;
  }

  private async metadata(fileId: string): Promise<{ file: DriveFile; etag: string }> {
    // v2 exposes the resource ETag in JSON, avoiding reliance on a CORS-exposed response header.
    const response = await this.request(
      `${CONDITIONAL_API}/${safeId(fileId)}?fields=id,title,fileSize,etag,labels/trashed`,
    );
    if (!response.ok) throw new CloudVaultWriteConflictError();
    const value = (await response.json()) as {
      id: string;
      title: string;
      fileSize?: string;
      etag?: string;
      labels?: { trashed?: boolean };
    };
    const file: DriveFile = { id: value.id, name: value.title, size: value.fileSize, trashed: value.labels?.trashed };
    const etag = value.etag;
    // Never substitute version for ETag or downgrade to unguarded last-writer-wins.
    if (file.trashed || file.id !== fileId) throw new CloudVaultWriteConflictError();
    if (!etag || !/^"[^"\r\n]+"$/.test(etag))
      throw new Error('Drive의 동시 수정 보호 정보를 확인하지 못했습니다. 동기화를 중단했습니다.');
    return { file, etag };
  }
  private revision(id: string, etag: string) {
    return JSON.stringify([id, etag]);
  }

  async getRevision(): Promise<string | undefined> {
    const root = await this.folder(false);
    const file = root ? await this.find('manifest', root) : undefined;
    if (!file) return undefined;
    const meta = await this.metadata(file.id);
    return this.revision(file.id, meta.etag);
  }
  async read() {
    const root = await this.folder(false);
    const file = root ? await this.find('manifest', root) : undefined;
    if (!file) return undefined;
    const before = await this.metadata(file.id);
    if (!before.file.size || Number(before.file.size) > MANIFEST_LIMIT)
      throw new Error('Drive 독서 기록 파일이 너무 큽니다.');
    const response = await this.request(`${API}/${file.id}?alt=media`);
    if (!response.ok) throw new CloudVaultWriteConflictError();
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MANIFEST_LIMIT || bytes.byteLength !== Number(before.file.size))
      throw new CloudVaultWriteConflictError();
    const after = await this.metadata(file.id);
    if (after.etag !== before.etag) throw new CloudVaultWriteConflictError();
    return { bytes, revision: this.revision(file.id, before.etag) };
  }

  private async upload(name: string, key: string, blob: Blob, root: string): Promise<DriveFile> {
    const init = await this.request(`${UPLOAD}?uploadType=resumable&fields=id,name,size`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': blob.type || 'application/octet-stream',
        'X-Upload-Content-Length': String(blob.size),
      },
      body: JSON.stringify({ name, parents: [root], appProperties: { moyaVault: NAMESPACE, moyaObject: key } }),
    });
    if (!init.ok) throw new Error('Drive 업로드를 시작하지 못했습니다.');
    const location = init.headers.get('location');
    if (!location) throw new Error('Drive 업로드 주소가 없습니다.');
    let result: DriveFile | undefined;
    for (let offset = 0; offset < blob.size; offset += CHUNK) {
      const end = Math.min(offset + CHUNK, blob.size);
      const response = await this.request(location, {
        method: 'PUT',
        headers: {
          'Content-Type': blob.type || 'application/octet-stream',
          'Content-Range': `bytes ${offset}-${end - 1}/${blob.size}`,
        },
        body: blob.slice(offset, end),
      });
      if (response.status === 308) {
        if (end === blob.size || response.headers.get('range') !== `bytes=0-${end - 1}`)
          throw new Error('Drive 업로드 진행을 확인하지 못했습니다. 다시 동기화하세요.');
      } else {
        if (!response.ok || end !== blob.size) throw new Error('Drive 업로드를 완료하지 못했습니다.');
        result = (await response.json()) as DriveFile;
      }
    }
    if (!result || Number(result.size) !== blob.size) throw new Error('Drive 업로드 크기가 일치하지 않습니다.');
    safeId(result.id);
    return result;
  }
  async write(bytes: Uint8Array, expectedRevision?: string) {
    if (!bytes.byteLength || bytes.byteLength > MANIFEST_LIMIT) throw new Error('Drive 독서 기록 파일이 너무 큽니다.');
    const root = (await this.folder(true))!;
    const current = await this.find('manifest', root);
    let file: DriveFile;
    if (current) {
      const meta = await this.metadata(current.id);
      if (this.revision(current.id, meta.etag) !== expectedRevision) throw new CloudVaultWriteConflictError();
      const response = await this.request(`${CONDITIONAL_UPLOAD}/${current.id}?uploadType=media`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'If-Match': meta.etag },
        body: new Blob([bytes as BlobPart]),
      });
      if (!response.ok) throw new CloudVaultWriteConflictError();
      file = current;
    } else {
      if (expectedRevision) throw new CloudVaultWriteConflictError();
      file = await this.upload(
        CLOUD_VAULT_FILE_NAME,
        'manifest',
        new Blob([bytes as BlobPart], { type: 'application/json' }),
        root,
      );
    }
    const confirmed = await this.find('manifest', root);
    if (confirmed?.id !== file.id) throw new CloudVaultWriteConflictError();
    const committed = await this.read();
    if (
      !committed ||
      committed.bytes.length !== bytes.length ||
      !committed.bytes.every((value, index) => value === bytes[index])
    ) {
      throw new CloudVaultWriteConflictError();
    }
    return { revision: committed.revision };
  }
  async getObject(objectKey: string) {
    safeKey(objectKey);
    const root = await this.folder(false);
    const file = root ? await this.find(objectKey, root) : undefined;
    if (!file) return undefined;
    const response = await this.request(`${API}/${file.id}?alt=media`);
    if (!response.ok) throw new Error('Drive 작품 파일을 찾지 못했습니다.');
    return { blob: await response.blob(), revision: file.id };
  }
  async putObject(objectKey: string, blob: Blob, expected: { readonly byteLength: number }) {
    safeKey(objectKey);
    if (!blob.size || blob.size !== expected.byteLength) throw new Error('Cloud Vault object size is invalid.');
    const root = (await this.folder(true))!;
    const existing = await this.find(objectKey, root);
    if (existing) {
      if (Number(existing.size) !== blob.size) throw new Error('Drive에 저장된 작품 파일의 크기가 다릅니다.');
      return { created: false, revision: existing.id };
    }
    const file = await this.upload(objectKey.split('/').join('_'), objectKey, blob, root);
    return { created: true, revision: file.id };
  }
}
