// Synthetic Drive REST contract for unit and real-browser flows. No real accounts or user files.
interface StoredFile {
  id: string;
  name: string;
  mimeType?: string;
  size: string;
  version: string;
  appProperties: Record<string, string>;
  parents?: string[];
  bytes: Uint8Array;
}
export class GoogleDriveFixture {
  files = new Map<string, StoredFile>();
  requests: { method: string; url: string; headers: Headers }[] = [];
  omitEtag = false;
  rejectWrite = false;
  rejectToken = false;
  incomplete = false;
  uploadLocation = 'https://www.googleapis.com/upload/drive/v3/files?upload_id=fixture';
  private nextId = 1;
  private upload?: { metadata: Omit<StoredFile, 'id' | 'version' | 'bytes'>; chunks: Uint8Array[] };
  private json(value: unknown, status = 200, headers?: HeadersInit) {
    return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  }
  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method || 'GET';
    const headers = new Headers(init.headers);
    this.requests.push({ method, url: url.href, headers });
    if (this.rejectToken) return this.json({ error: 'fixture token' }, 401);
    if (url.pathname.startsWith('/upload/')) {
      if (method === 'POST') {
        const metadata = JSON.parse(String(init.body));
        this.upload = { metadata: { ...metadata, size: headers.get('X-Upload-Content-Length') || '0' }, chunks: [] };
        return this.json({}, 200, { location: this.uploadLocation });
      }
      const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
      if (method === 'PUT' && url.searchParams.has('upload_id')) {
        if (!this.upload) return this.json({}, 400);
        this.upload.chunks.push(bytes);
        const received = this.upload.chunks.reduce((sum, part) => sum + part.length, 0);
        if (received < Number(this.upload.metadata.size))
          return this.json({}, 308, { range: `bytes=0-${received - 1}` });
        const all = new Uint8Array(received);
        let offset = 0;
        for (const part of this.upload.chunks) {
          all.set(part, offset);
          offset += part.length;
        }
        const file = { ...this.upload.metadata, id: `file-${this.nextId++}`, version: '1', bytes: all };
        this.files.set(file.id, file);
        this.upload = undefined;
        return this.json(this.metadata(file));
      }
      const id = url.pathname.split('/').pop()!;
      const file = this.files.get(id);
      if (!file) return this.json({}, 404);
      if (this.rejectWrite || headers.get('If-Match') !== `"${file.version}"`) return this.json({}, 412);
      file.bytes = bytes;
      file.size = String(bytes.length);
      file.version = String(Number(file.version) + 1);
      return this.json(this.metadata(file));
    }
    if (method === 'POST') {
      const metadata = JSON.parse(String(init.body));
      const file: StoredFile = {
        ...metadata,
        id: `file-${this.nextId++}`,
        version: '1',
        size: '0',
        bytes: new Uint8Array(),
      };
      this.files.set(file.id, file);
      return this.json(this.metadata(file));
    }
    const q = url.searchParams.get('q');
    if (q) {
      const key = /key='moyaObject' and value='([^']+)'/.exec(q)?.[1];
      const parent = /'([^']+)' in parents/.exec(q)?.[1];
      const files = [...this.files.values()].filter(
        (file) => file.appProperties.moyaObject === key && (!parent || file.parents?.includes(parent)),
      );
      return this.json({ files: files.map((file) => this.metadata(file)), incompleteSearch: this.incomplete });
    }
    const id = url.pathname.split('/').pop()!;
    const file = this.files.get(id);
    if (!file) return this.json({}, 404);
    if (url.searchParams.get('alt') === 'media') return new Response(file.bytes as BodyInit);
    if (url.pathname.includes('/v2/'))
      return this.json({
        id: file.id,
        title: file.name,
        fileSize: file.size,
        etag: this.omitEtag ? undefined : `"${file.version}"`,
        labels: { trashed: false },
      });
    return this.json(this.metadata(file), 200, this.omitEtag ? {} : { etag: `"${file.version}"` });
  };
  private metadata({ bytes: _bytes, ...file }: StoredFile) {
    return file;
  }
}
