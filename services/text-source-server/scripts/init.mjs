import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Creates only missing default files. Existing credentials and catalog identity are never read or replaced. */
export async function initializeSourceServer({ directory = process.cwd() } = {}) {
  const root = path.resolve(directory);
  const result = { ok: true, created: [], preserved: [] };
  let current = 'data/';
  async function ensureDirectory(relative) {
    current = relative;
    const target = path.join(root, relative);
    try {
      await mkdir(target, { mode: 0o700 });
      result.created.push(relative);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await lstat(target);
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error('directory_conflict', { cause: error });
      result.preserved.push(relative);
    }
  }
  async function createFile(relative, makeContent) {
    current = relative;
    let handle;
    try {
      handle = await open(path.join(root, relative), 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await lstat(path.join(root, relative));
      if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('file_conflict', { cause: error });
      result.preserved.push(relative);
      return;
    }
    try {
      await handle.writeFile(makeContent(), 'utf8');
      result.created.push(relative);
    } finally {
      await handle.close();
    }
  }
  try {
    await ensureDirectory('data/');
    await ensureDirectory('data/content/');
    await createFile(
      'data/catalog.json',
      () =>
        JSON.stringify(
          {
            instanceId: `text-server-${randomUUID()}`,
            dataNamespace: `library-${randomUUID()}`,
            sources: [],
          },
          null,
          2,
        ) + '\n',
    );
    await createFile('.env', () =>
      [
        '# Private local configuration. Do not commit or share this file.',
        `SERVER_KEY=${randomBytes(32).toString('base64url')}`,
        'CATALOG_FILE=./data/catalog.json',
        'SOURCE_ROOT=./data/content',
        'HOST=127.0.0.1',
        'PORT=9970',
        '# Set the exact Moya origin only for a direct browser connection.',
        'MOYA_ORIGIN=',
        'SOURCE_ADAPTERS=[]',
        'CONTENT_PROVIDER_PROTOCOL=job-v1',
        'CONTENT_PROVIDER_ENDPOINT=',
        'CONTENT_PROVIDER_KEY=',
        '',
      ].join('\n'),
    );
  } catch {
    result.ok = false;
    result.failed = current;
  }
  return result;
}

export function formatInitialization(result) {
  const lines = [];
  if (result.created.length) lines.push(`생성: ${result.created.join(', ')}`);
  if (result.preserved.length) lines.push(`기존 항목 보존: ${result.preserved.join(', ')}`);
  if (!result.ok)
    lines.push(
      `초기화 일부 실패: ${result.failed}. 대상의 파일·디렉터리 충돌과 쓰기 권한을 확인해 주세요.`,
      '이미 생성한 항목과 기존 파일은 그대로 두었습니다. 실패 대상에 빈 파일이 남았다면 직접 확인한 뒤 다시 실행해 주세요.',
    );
  else
    lines.push(
      '접속 키는 .env에만 저장되며 출력하지 않습니다. 기존 .env와 catalog는 변경하지 않았습니다.',
      'catalog에 작품을 등록하거나 SOURCE_ADAPTERS를 설정한 뒤 npm run check, npm start를 실행하세요.',
    );
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await initializeSourceServer();
  console.log(formatInitialization(result));
  process.exitCode = result.ok ? 0 : 1;
}
