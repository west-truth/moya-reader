import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [mode, profile, evidenceFile] = process.argv.slice(2);
assert(['seed', 'verify'].includes(mode));
const credentials = JSON.parse(await readFile(path.join(profile, 'server-credentials.json'), 'utf8'));
const baseUrl = `http://127.0.0.1:${credentials.ports.api}/api`;
async function request(resource, options = {}) {
  const response = await fetch(baseUrl + resource, {
    ...options,
    headers: { Authorization: `Bearer ${credentials.authToken}`, ...options.headers },
    signal: AbortSignal.timeout(15_000),
  });
  assert(response.ok, `${resource}: HTTP ${response.status}`);
  return response;
}
const original = Buffer.from('1화 설치 검증\n\n설치 업데이트 후에도 원본과 북마크가 보존됩니다.\n', 'utf8');
if (mode === 'seed') {
  const upload = await (
    await request('/uploads/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: '설치 보존 검증.txt',
        sizeBytes: original.length,
        contentType: 'text/plain',
        encoding: 'utf-8',
        chapterSplitMode: 'auto',
        totalChunks: 1,
      }),
    })
  ).json();
  await request(`/uploads/${upload.uploadId}/chunks/0`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: original,
  });
  const queued = await (await request(`/uploads/${upload.uploadId}/complete`, { method: 'POST' })).json();
  let imported;
  for (let attempt = 0; attempt < 120; attempt++) {
    const job = await (await request(`/import-jobs/${queued.jobId}`)).json();
    if (job.status === 'done') {
      imported = job;
      break;
    }
    assert(job.status !== 'failed', 'Installation fixture import failed');
    await delay(500);
  }
  assert(imported?.book_id, 'Installation fixture import did not finish');
  const bookId = imported.book_id;
  const chapters = await (await request(`/books/${bookId}/chapters`)).json();
  const chapter = (chapters.chapters ?? chapters)[0];
  assert(chapter?.id, 'No chapter after import');
  const bookmark = await (
    await request(`/books/${bookId}/bookmarks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'installed_upgrade_bookmark',
        chapterId: chapter.id,
        progress: 0,
        scrollTop: 0,
        createdAt: new Date().toISOString(),
        label: '설치 업데이트 보존',
      }),
    })
  ).json();
  assert.equal(bookmark.applied, true);
  await writeFile(evidenceFile, JSON.stringify({ bookId, bookmarkId: 'installed_upgrade_bookmark' }));
} else {
  const { bookId, bookmarkId } = JSON.parse(await readFile(evidenceFile, 'utf8'));
  assert(bookmarkId, 'Missing saved bookmark ID');
  const source = Buffer.from(await (await request(`/books/${bookId}/source`)).arrayBuffer());
  assert.deepEqual(source, original, 'Original source changed during update');
  const bookmarks = await (await request(`/books/${bookId}/bookmarks`)).json();
  assert(
    (bookmarks.bookmarks ?? bookmarks).some((item) => item.id === bookmarkId && item.label === '설치 업데이트 보존'),
    'Bookmark was not retained',
  );
}
console.log(`Installed library ${mode} passed`);
