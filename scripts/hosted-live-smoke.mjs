import { createHash } from 'node:crypto';
import process from 'node:process';
import { BlobWriter, TextReader, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js';

const args = process.argv.slice(2);

function argValue(name, fallback) {
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  return fallback;
}

function hasArg(name) {
  return args.includes(name);
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

function joinUrl(base, path) {
  return `${trimTrailingSlash(base)}${path.startsWith('/') ? path : `/${path}`}`;
}

const dryRun = hasArg('--dry-run');
const keepBook = hasArg('--keep-book') || process.env.HOSTED_SMOKE_KEEP_BOOK === '1';
const webBaseUrl = trimTrailingSlash(argValue('--web-url', process.env.HOSTED_WEB_URL ?? 'http://127.0.0.1:8080'));
const apiBaseUrl = trimTrailingSlash(argValue('--api-url', process.env.HOSTED_API_URL ?? joinUrl(webBaseUrl, '/api')));
const browserOrigin = argValue('--origin', process.env.HOSTED_SMOKE_ORIGIN ?? new URL(webBaseUrl).origin);
const timeoutMs = Number(argValue('--timeout-ms', process.env.HOSTED_SMOKE_TIMEOUT_MS ?? '120000'));
const authToken = argValue(
  '--auth-token',
  process.env.HOSTED_API_AUTH_TOKEN ?? process.env.READER_AUTH_TOKEN ?? process.env.VITE_API_AUTH_TOKEN ?? '',
).trim();

const smokeId = `smoke_${Date.now()}`;
const sampleText = [
  'Episode 1',
  '',
  'Hosted smoke test first paragraph.',
  '',
  'Episode 2',
  '',
  'This paragraph should be readable through the hosted page API.',
].join('\n');
const sampleBytes = new TextEncoder().encode(sampleText);
const sampleCoverBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9WlS8AAAAASUVORK5CYII=',
  'base64',
);
const sampleCoverHash = `sha256:${createHash('sha256').update(sampleCoverBytes).digest('hex')}`;
const sampleDocumentPageBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2ZQAAAABJRU5ErkJggg==',
  'base64',
);
const minimumUploadChunks = 3;
const requestedChunkBytes = Number(argValue('--chunk-bytes', process.env.HOSTED_SMOKE_CHUNK_BYTES ?? '48'));
const safeRequestedChunkBytes =
  Number.isFinite(requestedChunkBytes) && requestedChunkBytes > 0 ? Math.floor(requestedChunkBytes) : 48;
const uploadChunkBytes = Math.max(
  1,
  Math.min(safeRequestedChunkBytes, Math.ceil(sampleBytes.byteLength / minimumUploadChunks)),
);
const totalChunks = Math.max(1, Math.ceil(sampleBytes.byteLength / uploadChunkBytes));
const syncPageLimit = 500;
const maxSyncPages = 1000;
let negotiatedSyncContract;
let sessionCookie = '';

function authHeaders(extra = {}) {
  return {
    ...(browserOrigin ? { Origin: browserOrigin } : {}),
    ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    ...(sessionCookie ? { Cookie: sessionCookie } : {}),
    ...extra,
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function integrityHash(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function bookField(book, snakeName, camelName) {
  return book?.[snakeName] ?? book?.[camelName];
}

function jsonBody(body) {
  return {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

async function request(path, options = {}) {
  const url = path.startsWith('http') ? path : joinUrl(apiBaseUrl, path);
  const response = await fetch(url, {
    ...options,
    headers: {
      ...authHeaders(),
      ...options.headers,
    },
  });
  const text = await response.text();
  let body;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    throw new Error(`${options.method ?? 'GET'} ${url} failed with ${response.status}: ${text || response.statusText}`);
  }
  return body;
}

async function waitForReadiness() {
  const startedAt = Date.now();
  let lastResult = 'no response';
  const readyUrl = joinUrl(webBaseUrl, '/ready');
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(readyUrl, {
        headers: browserOrigin ? { Origin: browserOrigin } : undefined,
      });
      const text = await response.text();
      let body;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = undefined;
      }
      if (response.ok && body?.ok === true) return body;
      lastResult = `${response.status}: ${text || response.statusText}`;
    } catch (error) {
      lastResult = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`readiness did not become healthy within ${timeoutMs}ms (${lastResult})`);
}

function syncEvents(response) {
  assert(Array.isArray(response.events), 'sync pull did not return an events array');
  return response.events;
}

function syncCursor(response, previousCursor) {
  const cursor = Number(response.cursor ?? previousCursor);
  assert(Number.isFinite(cursor), 'sync pull did not return a numeric cursor');
  return cursor;
}

function eventPayload(event) {
  if (!event?.payload) return {};
  if (typeof event.payload === 'string') {
    try {
      return JSON.parse(event.payload);
    } catch {
      return {};
    }
  }
  return event.payload;
}

function hasSyncEvent(events, type, predicate) {
  return events.some((event) => event.type === type && predicate(event, eventPayload(event)));
}

function assertSyncEvent(events, type, predicate) {
  assert(hasSyncEvent(events, type, predicate), `sync pull did not include expected ${type} event`);
}

async function negotiateAuthenticatedSyncContract() {
  const capabilities = await request('/sync/capabilities');
  const supportedContracts = Array.isArray(capabilities.supportedContracts) ? capabilities.supportedContracts : [];
  const contract = supportedContracts.find((candidate) => Number(candidate?.contractVersion) === 2);
  assert(contract, 'authenticated sync capabilities do not include contract v2');
  assert(typeof contract.idContract === 'string' && contract.idContract, 'sync v2 idContract is missing');
  assert(typeof contract.hashContract === 'string' && contract.hashContract, 'sync v2 hashContract is missing');
  negotiatedSyncContract = {
    contractVersion: 2,
    idContract: contract.idContract,
    hashContract: contract.hashContract,
  };
  console.log('ok authenticated API probe and sync v2 negotiation');
}

async function verifyProtectedApiBoundary() {
  const publicReady = await fetch(joinUrl(webBaseUrl, '/ready'), {
    headers: browserOrigin ? { Origin: browserOrigin } : undefined,
  });
  assert(publicReady.ok, `public readiness without a token returned ${publicReady.status}`);
  const endpoint = joinUrl(apiBaseUrl, '/sync/capabilities');
  const publicHeaders = browserOrigin ? { Origin: browserOrigin } : undefined;
  const statusResponse = await fetch(joinUrl(apiBaseUrl, '/auth/status'), { headers: publicHeaders });
  assert(statusResponse.ok, `owner account status returned ${statusResponse.status}`);
  const accountStatus = await statusResponse.json();

  let unauthenticated = await fetch(endpoint, { headers: publicHeaders });
  if (accountStatus.setupRequired === true) {
    assert(
      unauthenticated.status === 503,
      `protected API before owner setup returned ${unauthenticated.status}, expected 503`,
    );
    const setupFailure = await unauthenticated.json();
    assert(setupFailure.error === 'account_setup_required', 'pre-setup protected API did not explain owner setup');

    const registration = await fetch(joinUrl(apiBaseUrl, '/auth/register'), {
      method: 'POST',
      headers: { ...publicHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'moya-ci-owner',
        displayName: 'Moya CI Owner',
        password: 'moya-ci-owner-password',
        ...(authToken ? { setupCode: authToken } : {}),
      }),
    });
    const registrationText = await registration.text();
    assert(
      registration.status === 201,
      `owner account registration returned ${registration.status}: ${registrationText}`,
    );
    sessionCookie = registration.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
    assert(sessionCookie, 'owner account registration did not issue a session cookie');
    const session = await fetch(joinUrl(apiBaseUrl, '/auth/session'), {
      headers: { ...publicHeaders, Cookie: sessionCookie },
    });
    assert(session.ok, `owner session cookie probe returned ${session.status}`);
    unauthenticated = await fetch(endpoint, { headers: publicHeaders });
    console.log('ok created the owner account and restored its session cookie');
  }

  assert(unauthenticated.status === 401, `protected API without a session returned ${unauthenticated.status}`);
  if (authToken) {
    const wrongToken = await fetch(endpoint, {
      headers: { ...publicHeaders, Authorization: `Bearer ${authToken}-wrong` },
    });
    assert(wrongToken.status === 401, `protected API with a wrong token returned ${wrongToken.status}, expected 401`);
  }
  console.log(
    authToken
      ? 'ok readiness is public and protected API rejects missing sessions and incorrect recovery tokens'
      : 'ok readiness is public and protected API rejects missing sessions',
  );
}

function syncPullPath(since) {
  assert(negotiatedSyncContract, 'sync contract must be negotiated before pulling events');
  const query = new URLSearchParams({
    since: String(since),
    contractVersion: String(negotiatedSyncContract.contractVersion),
    idContract: negotiatedSyncContract.idContract,
    hashContract: negotiatedSyncContract.hashContract,
  });
  return `/sync?${query.toString()}`;
}

async function syncCursorAtEnd() {
  let cursor = 0;
  for (let page = 0; page < maxSyncPages; page += 1) {
    const response = await request(syncPullPath(cursor));
    const events = syncEvents(response);
    const nextCursor = syncCursor(response, cursor);
    if (!events.length || nextCursor === cursor) return cursor;
    cursor = nextCursor;
    if (events.length < syncPageLimit) return cursor;
  }
  throw new Error(`Sync cursor drain exceeded ${maxSyncPages} pages`);
}

async function pullSyncEventsSince(cursor) {
  let currentCursor = cursor;
  const allEvents = [];
  for (let page = 0; page < maxSyncPages; page += 1) {
    const response = await request(syncPullPath(currentCursor));
    const events = syncEvents(response);
    const nextCursor = syncCursor(response, currentCursor);
    allEvents.push(...events);
    if (!events.length || nextCursor === currentCursor) return allEvents;
    currentCursor = nextCursor;
    if (events.length < syncPageLimit) return allEvents;
  }
  throw new Error(`Sync pull exceeded ${maxSyncPages} pages`);
}

async function waitForImport(jobId) {
  const startedAt = Date.now();
  let lastJob;
  while (Date.now() - startedAt < timeoutMs) {
    const job = await request(`/import-jobs/${encodeURIComponent(jobId)}`);
    lastJob = job;
    if (job.status === 'done') return job;
    if (job.status === 'failed') throw new Error(`Import job failed: ${job.error_message ?? job.message ?? jobId}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Import job timed out after ${timeoutMs}ms: ${JSON.stringify(lastJob)}`);
}

async function singleReleaseSeriesComicArchive({
  collectionRemoteId,
  title,
  releaseId,
  releaseTitle,
  chapterNumber,
  pageBytes,
  targetBookId,
}) {
  const pageEntryName = 'chapters/000001/00001.png';
  const writer = new ZipWriter(new BlobWriter('application/vnd.comicbook+zip'));
  await writer.add(pageEntryName, new Uint8ArrayReader(pageBytes), { level: 0 });
  await writer.add(
    'moya-series.json',
    new TextReader(
      JSON.stringify({
        schemaVersion: 1,
        collection: { remoteId: collectionRemoteId, title },
        ...(targetBookId ? { targetBookId } : {}),
        chapters: [
          {
            remoteId: releaseId,
            title: releaseTitle,
            chapterNumber,
            sourceOrder: chapterNumber,
            remoteRevision: `smoke-r${chapterNumber}`,
            sourceContentHash: integrityHash(pageBytes),
            pageCount: 1,
            entryNames: [pageEntryName],
          },
        ],
      }),
    ),
  );
  await writer.add(
    'ComicInfo.xml',
    new TextReader(
      `<?xml version="1.0" encoding="utf-8"?><ComicInfo><Title>${title}</Title><PageCount>1</PageCount></ComicInfo>`,
    ),
  );
  return new Uint8Array(await (await writer.close()).arrayBuffer());
}

async function uploadSingleChunkBook({
  bookId,
  fileName,
  contentType,
  bytes,
  importMode = 'replace_book',
  baseActiveContentRevisionId,
}) {
  const upload = await request('/uploads/init', {
    method: 'POST',
    ...jsonBody({
      fileName,
      sizeBytes: bytes.byteLength,
      contentType,
      encoding: 'auto',
      chapterSplitMode: 'auto',
      totalChunks: 1,
      clientBookId: bookId,
      importMode,
      ...(importMode === 'append_image_series'
        ? {
            baseActiveContentRevisionId,
            sourceContentHash: integrityHash(bytes),
          }
        : {}),
    }),
  });
  assert(typeof upload.uploadId === 'string', 'fixed-document upload init did not return uploadId');
  await request(`/uploads/${encodeURIComponent(upload.uploadId)}/chunks/0`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bytes,
  });
  const complete = await request(`/uploads/${encodeURIComponent(upload.uploadId)}/complete`, { method: 'POST' });
  assert(typeof complete.jobId === 'string', 'fixed-document upload complete did not return jobId');
  const job = await waitForImport(complete.jobId);
  assert((job.book_id ?? bookId) === bookId, 'fixed-document import returned a different book id');
  return job;
}

async function activeCatalogBook(bookId) {
  const catalog = await request('/books?limit=1000');
  return catalog.books?.find((candidate) => candidate.id === bookId);
}

async function cleanupSmokeBook(bookId) {
  const manifestResponse = await fetch(joinUrl(apiBaseUrl, `/books/${encodeURIComponent(bookId)}/manifest`), {
    headers: authHeaders(),
  });
  let contentRevisionId;
  let metadataRevision;
  if (manifestResponse.ok) {
    const manifest = await manifestResponse.json();
    contentRevisionId = String(bookField(manifest.book, 'active_content_revision_id', 'activeContentRevisionId') ?? '');
    metadataRevision = Number(bookField(manifest.book, 'metadata_revision', 'metadataRevision'));
    const trashed = await request(`/books/${encodeURIComponent(bookId)}`, {
      method: 'DELETE',
      ...jsonBody({
        expectedRevision: metadataRevision,
        expectedContentRevisionId: contentRevisionId,
        deviceId: 'hosted-live-smoke',
      }),
    });
    metadataRevision = Number(trashed.metadataRevision);
  } else if (manifestResponse.status === 409) {
    const book = await activeCatalogBook(bookId);
    if (!book) throw new Error('cleanup could not resolve the active reused-id book');
    contentRevisionId = String(bookField(book, 'active_content_revision_id', 'activeContentRevisionId') ?? '');
    metadataRevision = Number(bookField(book, 'metadata_revision', 'metadataRevision'));
    const trashed = await request(`/books/${encodeURIComponent(bookId)}`, {
      method: 'DELETE',
      ...jsonBody({
        expectedRevision: metadataRevision,
        expectedContentRevisionId: contentRevisionId,
        deviceId: 'hosted-live-smoke',
      }),
    });
    metadataRevision = Number(trashed.metadataRevision);
  } else if (manifestResponse.status === 404) {
    const trash = await request('/trash/books');
    const book = trash.books?.find((candidate) => candidate.id === bookId);
    if (!book) return false;
    contentRevisionId = String(bookField(book, 'active_content_revision_id', 'activeContentRevisionId') ?? '');
    metadataRevision = Number(bookField(book, 'metadata_revision', 'metadataRevision'));
  } else {
    throw new Error(`cleanup manifest probe returned ${manifestResponse.status}`);
  }
  assert(contentRevisionId, 'cleanup could not resolve the active content revision');
  assert(Number.isSafeInteger(metadataRevision), 'cleanup could not resolve the metadata revision');
  await request(`/trash/books/${encodeURIComponent(bookId)}`, {
    method: 'DELETE',
    ...jsonBody({ expectedRevision: metadataRevision, expectedContentRevisionId: contentRevisionId }),
  });
  return true;
}

async function run() {
  console.log(`Hosted smoke target: web=${webBaseUrl} api=${apiBaseUrl} origin=${browserOrigin}`);
  if (dryRun) {
    console.log('Dry run only; no network requests were made.');
    return;
  }

  const webResponse = await fetch(joinUrl(webBaseUrl, '/'));
  assert(webResponse.ok, `web root returned ${webResponse.status}`);
  const html = await webResponse.text();
  assert(html.includes('<div id="root"></div>'), 'web root did not look like the Vite app shell');
  console.log('ok web root served app shell');

  const ready = await waitForReadiness();
  assert(ready.ok === true, 'readiness endpoint did not return ok=true');
  assert(ready.components?.database?.ok === true, 'readiness database check failed');
  assert(ready.components?.queue?.ok === true, 'readiness queue check failed');
  assert(ready.components?.objectStorage?.ok === true, 'readiness object storage check failed');
  assert(ready.components?.worker?.ok === true, 'readiness worker heartbeat check failed');
  console.log('ok readiness reports database, queue, object storage, and worker');

  await verifyProtectedApiBoundary();
  await negotiateAuthenticatedSyncContract();

  const beforeBooks = await request('/books');
  assert(Array.isArray(beforeBooks.books), 'GET /books did not return a books array');
  console.log(`ok listed hosted library (${beforeBooks.books.length} book(s) before smoke import)`);
  const syncCursor = await syncCursorAtEnd();

  let importedBookId;
  let fixedDocumentBookId;
  try {
    const upload = await request('/uploads/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: `${smokeId}.txt`,
        sizeBytes: sampleBytes.byteLength,
        contentType: 'text/plain',
        encoding: 'utf-8',
        chapterSplitMode: 'mixed',
        totalChunks,
        clientBookId: smokeId,
      }),
    });
    assert(typeof upload.uploadId === 'string', 'upload init did not return uploadId');
    console.log(`ok initialized hosted TXT upload (${totalChunks} chunks, ${uploadChunkBytes} bytes max each)`);

    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
      const start = chunkIndex * uploadChunkBytes;
      const chunk = sampleBytes.slice(start, Math.min(sampleBytes.byteLength, start + uploadChunkBytes));
      const chunkResult = await request(`/uploads/${encodeURIComponent(upload.uploadId)}/chunks/${chunkIndex}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: chunk,
      });
      assert(chunkResult.chunkIndex === chunkIndex, `chunk ${chunkIndex} response returned wrong index`);
      assert(chunkResult.sizeBytes === chunk.byteLength, `chunk ${chunkIndex} response returned wrong size`);
    }
    const uploadStatus = await request(`/uploads/${encodeURIComponent(upload.uploadId)}`);
    const expectedChunkIndexes = Array.from({ length: totalChunks }, (_item, index) => index);
    const receivedChunkIndexes = Array.isArray(uploadStatus.receivedChunkIndexes)
      ? [...uploadStatus.receivedChunkIndexes].sort((a, b) => a - b)
      : [];
    const missingChunkIndexes = Array.isArray(uploadStatus.missingChunkIndexes)
      ? [...uploadStatus.missingChunkIndexes].sort((a, b) => a - b)
      : [];
    assert(uploadStatus.totalChunks === totalChunks, 'upload status reported the wrong chunk count');
    assert(
      uploadStatus.chapterSplitMode === 'mixed',
      'upload status did not preserve the requested chapter split mode',
    );
    assert(
      uploadStatus.uploadedBytes === sampleBytes.byteLength,
      'upload status reported the wrong uploaded byte count',
    );
    assert(
      arraysEqual(receivedChunkIndexes, expectedChunkIndexes),
      'upload status did not report every received chunk',
    );
    assert(missingChunkIndexes.length === 0, 'upload status still reported missing chunks');
    assert(uploadStatus.complete === true, 'upload status did not report complete chunk set');
    console.log('ok uploaded TXT chunks and status reports completion');

    const complete = await request(`/uploads/${encodeURIComponent(upload.uploadId)}/complete`, { method: 'POST' });
    assert(typeof complete.jobId === 'string', 'upload complete did not return jobId');
    console.log('ok queued import job');

    const job = await waitForImport(complete.jobId);
    importedBookId = job.book_id ?? smokeId;
    assert(importedBookId, 'completed import job did not include book_id');
    console.log(`ok import job completed for ${importedBookId}`);

    const manifest = await request(`/books/${encodeURIComponent(importedBookId)}/manifest`);
    assert(manifest.book?.id === importedBookId, 'manifest did not return imported book');
    const chapters = await request(`/books/${encodeURIComponent(importedBookId)}/chapters`);
    assert(Array.isArray(chapters.chapters) && chapters.chapters.length >= 1, 'chapters endpoint returned no chapters');
    const firstChapter = chapters.chapters[0];
    const pages = await request(`/chapters/${encodeURIComponent(firstChapter.id)}/pages?from=0&count=1`);
    assert(
      Array.isArray(pages.pages) && pages.pages[0]?.paragraphs?.length >= 1,
      'page endpoint returned no paragraphs',
    );
    const firstParagraph = pages.pages[0].paragraphs[0];
    console.log('ok opened imported manifest, chapters, and first page');

    const coverEndpoint = joinUrl(apiBaseUrl, `/books/${encodeURIComponent(importedBookId)}/cover/metadata`);
    const beforeCoverResponse = await fetch(coverEndpoint, { headers: authHeaders() });
    assert(
      beforeCoverResponse.status === 200 || beforeCoverResponse.status === 404,
      `cover metadata preflight returned ${beforeCoverResponse.status}`,
    );
    const beforeCover = beforeCoverResponse.status === 200 ? (await beforeCoverResponse.json()).cover : undefined;
    const beforeMetadataRevision = Number(manifest.book.metadata_revision ?? manifest.book.metadataRevision ?? 0);
    const importedContentRevisionId = String(
      bookField(manifest.book, 'active_content_revision_id', 'activeContentRevisionId') ?? '',
    );
    assert(importedContentRevisionId, 'imported text book did not expose its active content revision');
    const approvedCover = await request(`/books/${encodeURIComponent(importedBookId)}/cover/approved-enrichment`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Cover-File-Name': encodeURIComponent(`${smokeId}.png`),
        'X-Cover-Content-Type': 'image/png',
        'X-Cover-Content-Hash': sampleCoverHash,
        'X-Cover-Width': '1',
        'X-Cover-Height': '1',
        'X-Cover-Fit': 'contain',
        'X-Cover-Position-X': '50',
        'X-Cover-Position-Y': '50',
        'X-Expected-Metadata-Revision': String(beforeMetadataRevision),
        'X-Expected-Content-Revision-Id': importedContentRevisionId,
      },
      body: sampleCoverBytes,
    });
    assert(approvedCover.cover?.provenance === 'approved_enrichment', 'approved cover provenance was not retained');
    assert(approvedCover.cover?.content_hash === sampleCoverHash, 'approved cover hash was not retained');
    assert(
      Number(approvedCover.metadataRevision) === beforeMetadataRevision + 1,
      'approved cover did not increment metadata revision exactly once',
    );
    if (beforeCover) {
      assert(
        approvedCover.previousCover?.id === beforeCover.id && approvedCover.previousCover?.status === 'superseded',
        'previous cover was not retained for safe restore',
      );
    } else {
      assert(approvedCover.previousCover === null, 'no-cover approval unexpectedly returned a previous cover');
    }
    const restoredCover = await request(
      `/books/${encodeURIComponent(importedBookId)}/cover/approved-enrichment/restore`,
      {
        method: 'POST',
        ...jsonBody({
          expectedMetadataRevision: approvedCover.metadataRevision,
          expectedContentRevisionId: importedContentRevisionId,
          expectedActiveAssetId: approvedCover.cover.id,
          expectedActiveContentHash: approvedCover.cover.content_hash,
          previousAssetId: beforeCover?.id,
          previousContentHash: beforeCover?.content_hash,
          previousFit: manifest.book.cover_fit ?? manifest.book.coverFit ?? 'crop',
          previousPositionX: Number(manifest.book.cover_position_x ?? manifest.book.coverPositionX ?? 50),
          previousPositionY: Number(manifest.book.cover_position_y ?? manifest.book.coverPositionY ?? 50),
        }),
      },
    );
    assert(
      Number(restoredCover.metadataRevision) === Number(approvedCover.metadataRevision) + 1,
      'approved cover restore did not increment metadata revision exactly once',
    );
    if (beforeCover) {
      assert(
        restoredCover.cover?.id === beforeCover.id,
        'approved cover restore did not reactivate the previous cover',
      );
    } else {
      assert(restoredCover.cover === null, 'approved cover restore did not return to an empty cover');
    }
    console.log('ok applied and safely restored a hosted approved enrichment cover');

    fixedDocumentBookId = `${smokeId}_comic`;
    const comicCollectionRemoteId = `${smokeId}_suwayomi_work`;
    const firstReleaseId = 'chapter:smoke-1';
    const secondReleaseId = 'chapter:smoke-2';
    const comicBytes = await singleReleaseSeriesComicArchive({
      collectionRemoteId: comicCollectionRemoteId,
      title: 'Hosted fixed document smoke',
      releaseId: firstReleaseId,
      releaseTitle: '1화',
      chapterNumber: 1,
      pageBytes: sampleDocumentPageBytes,
    });
    await uploadSingleChunkBook({
      bookId: fixedDocumentBookId,
      fileName: `${fixedDocumentBookId}.cbz`,
      contentType: 'application/vnd.comicbook+zip',
      bytes: comicBytes,
    });
    const comicManifest = await request(`/books/${encodeURIComponent(fixedDocumentBookId)}/manifest`);
    const comicChapters = await request(`/books/${encodeURIComponent(fixedDocumentBookId)}/chapters`);
    const comicChapter = comicChapters.chapters?.find((chapter) => chapter.document_section_id === firstReleaseId);
    assert(comicManifest.book?.format === 'image_archive', 'comic smoke import was not materialized as image_archive');
    assert(comicChapter?.id, 'comic smoke import did not preserve the first release section id');
    const comicPages = await request(`/chapters/${encodeURIComponent(comicChapter.id)}/pages?from=0&count=1`);
    const comicAssetId = comicPages.pages?.[0]?.paragraphs?.[0]?.assetId;
    assert(comicAssetId, 'comic smoke page did not expose its document asset id');
    const comicResourceResponse = await fetch(
      joinUrl(
        apiBaseUrl,
        `/books/${encodeURIComponent(fixedDocumentBookId)}/resources/${encodeURIComponent(comicAssetId)}`,
      ),
      { headers: authHeaders() },
    );
    const comicResourceBytes = Buffer.from(await comicResourceResponse.arrayBuffer());
    assert(comicResourceResponse.ok, `comic resource returned ${comicResourceResponse.status}`);
    assert(
      comicResourceBytes.equals(sampleDocumentPageBytes),
      'comic resource response did not preserve the exact stored page bytes',
    );
    assert(
      comicResourceResponse.headers.get('cache-control')?.includes('immutable'),
      'content-addressed comic resource was not marked immutable',
    );
    console.log('ok opened exact hosted image-archive page bytes');

    const comicCoverBefore = await request(`/books/${encodeURIComponent(fixedDocumentBookId)}/cover/metadata`);
    const comicCoverResponse = await fetch(
      joinUrl(apiBaseUrl, `/books/${encodeURIComponent(fixedDocumentBookId)}/cover`),
      { headers: authHeaders() },
    );
    assert(comicCoverResponse.ok, `comic cover returned ${comicCoverResponse.status}`);
    assert(
      comicCoverResponse.headers.get('x-asset-id') === comicCoverBefore.cover.id &&
        comicCoverResponse.headers.get('x-asset-provenance') === 'archive_embedded' &&
        comicCoverResponse.headers.get('x-asset-content-hash') === comicCoverBefore.cover.content_hash,
      'comic cover download did not expose complete inline metadata',
    );
    const comicRevisionBefore = Number(
      comicManifest.book.metadata_revision ?? comicManifest.book.metadataRevision ?? 0,
    );
    const comicContentRevisionBefore = String(
      bookField(comicManifest.book, 'active_content_revision_id', 'activeContentRevisionId') ?? '',
    );
    assert(comicContentRevisionBefore, 'comic smoke import did not expose its active content revision');
    const sourceCover = await request(`/books/${encodeURIComponent(fixedDocumentBookId)}/cover/approved-enrichment`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Cover-File-Name': encodeURIComponent(`${fixedDocumentBookId}-source.png`),
        'X-Cover-Content-Type': 'image/png',
        'X-Cover-Content-Hash': sampleCoverHash,
        'X-Cover-Width': '1',
        'X-Cover-Height': '1',
        'X-Cover-Fit': 'crop',
        'X-Cover-Position-X': '50',
        'X-Cover-Position-Y': '50',
        'X-Expected-Metadata-Revision': String(comicRevisionBefore),
        'X-Expected-Content-Revision-Id': comicContentRevisionBefore,
      },
      body: sampleCoverBytes,
    });
    assert(sourceCover.cover?.content_hash === sampleCoverHash, 'source cover was not applied to comic smoke book');
    const secondReleaseBytes = await singleReleaseSeriesComicArchive({
      collectionRemoteId: comicCollectionRemoteId,
      title: 'Hosted fixed document smoke',
      releaseId: secondReleaseId,
      releaseTitle: '2화',
      chapterNumber: 2,
      pageBytes: sampleCoverBytes,
      targetBookId: fixedDocumentBookId,
    });
    await uploadSingleChunkBook({
      bookId: fixedDocumentBookId,
      fileName: `${fixedDocumentBookId}.cbz`,
      contentType: 'application/vnd.comicbook+zip',
      bytes: secondReleaseBytes,
      importMode: 'append_image_series',
      baseActiveContentRevisionId: comicContentRevisionBefore,
    });
    const comicCoverAfterUpdate = await request(`/books/${encodeURIComponent(fixedDocumentBookId)}/cover/metadata`);
    assert(
      comicCoverAfterUpdate.cover?.id === sourceCover.cover.id &&
        comicCoverAfterUpdate.cover?.content_hash === sampleCoverHash &&
        comicCoverAfterUpdate.cover?.provenance === 'approved_enrichment',
      'comic content update replaced the approved source cover',
    );
    const comicManifestAfterUpdate = await request(`/books/${encodeURIComponent(fixedDocumentBookId)}/manifest`);
    const comicContentRevisionAfterAppend = String(
      bookField(comicManifestAfterUpdate.book, 'active_content_revision_id', 'activeContentRevisionId') ?? '',
    );
    assert(
      comicContentRevisionAfterAppend && comicContentRevisionAfterAppend !== comicContentRevisionBefore,
      'comic chapter append did not activate a new content revision',
    );
    const chaptersAfterAppend = await request(`/books/${encodeURIComponent(fixedDocumentBookId)}/chapters`);
    const firstReleaseChapter = chaptersAfterAppend.chapters?.find(
      (chapter) => chapter.document_section_id === firstReleaseId,
    );
    const secondReleaseChapter = chaptersAfterAppend.chapters?.find(
      (chapter) => chapter.document_section_id === secondReleaseId,
    );
    assert(firstReleaseChapter?.id, 'comic chapter append lost the first release');
    assert(secondReleaseChapter?.id, 'comic chapter append did not expose the second release by its own section id');
    const secondReleasePages = await request(
      `/chapters/${encodeURIComponent(secondReleaseChapter.id)}/pages?from=0&count=1`,
    );
    const secondReleaseParagraph = secondReleasePages.pages?.[0]?.paragraphs?.[0];
    assert(secondReleaseParagraph?.assetId, 'second comic release did not expose its own page asset');
    const secondReleaseResource = await fetch(
      joinUrl(
        apiBaseUrl,
        `/books/${encodeURIComponent(fixedDocumentBookId)}/resources/${encodeURIComponent(secondReleaseParagraph.assetId)}`,
      ),
      { headers: authHeaders() },
    );
    assert(secondReleaseResource.ok, `second comic release resource returned ${secondReleaseResource.status}`);
    assert(
      Buffer.from(await secondReleaseResource.arrayBuffer()).equals(sampleCoverBytes),
      'opening the second release returned bytes from a different release',
    );
    const secondReleaseReadAt = new Date().toISOString();
    const secondReleasePosition = await request(`/books/${encodeURIComponent(fixedDocumentBookId)}/reading-position`, {
      method: 'PATCH',
      ...jsonBody({
        chapterId: secondReleaseChapter.id,
        paragraphId: secondReleaseParagraph.id,
        paragraphIndex: secondReleaseParagraph.index,
        offsetInParagraph: 0,
        chapterProgress: 0.25,
        scrollTop: 0,
        deviceId: 'hosted-live-smoke',
        documentSectionId: secondReleaseId,
        expectedContentRevisionId: comicContentRevisionAfterAppend,
        updatedAt: secondReleaseReadAt,
      }),
    });
    assert(secondReleasePosition.applied === true, 'second comic release reading position was not applied');
    const chaptersAfterRead = await request(`/books/${encodeURIComponent(fixedDocumentBookId)}/chapters`);
    assert(
      chaptersAfterRead.chapters
        ?.filter((chapter) => chapter.document_section_id === firstReleaseId)
        .every((chapter) => !chapter.document_section_read_at),
      'reading the second comic release incorrectly marked the first release as read',
    );
    assert(
      chaptersAfterRead.chapters
        ?.filter((chapter) => chapter.document_section_id === secondReleaseId)
        .every((chapter) => Boolean(chapter.document_section_read_at)),
      'reading the second comic release did not mark that exact release as read',
    );
    const restoredComicCover = await request(
      `/books/${encodeURIComponent(fixedDocumentBookId)}/cover/approved-enrichment/restore`,
      {
        method: 'POST',
        ...jsonBody({
          expectedMetadataRevision: Number(
            comicManifestAfterUpdate.book.metadata_revision ?? comicManifestAfterUpdate.book.metadataRevision,
          ),
          expectedContentRevisionId: comicContentRevisionAfterAppend,
          expectedActiveAssetId: sourceCover.cover.id,
          expectedActiveContentHash: sampleCoverHash,
          previousAssetId: comicCoverBefore.cover.id,
          previousContentHash: comicCoverBefore.cover.content_hash,
          previousFit: comicManifest.book.cover_fit ?? comicManifest.book.coverFit ?? 'contain',
          previousPositionX: Number(comicManifest.book.cover_position_x ?? comicManifest.book.coverPositionX ?? 50),
          previousPositionY: Number(comicManifest.book.cover_position_y ?? comicManifest.book.coverPositionY ?? 50),
        }),
      },
    );
    assert(
      restoredComicCover.cover?.id === comicCoverBefore.cover.id,
      'comic content update removed the safely restorable previous cover',
    );
    console.log('ok appended and opened an exact comic release without replacing its source cover or read states');

    const comicMetadataRevisionAfterRestore = Number(restoredComicCover.metadataRevision);
    const trashedComic = await request(`/books/${encodeURIComponent(fixedDocumentBookId)}`, {
      method: 'DELETE',
      ...jsonBody({
        expectedRevision: comicMetadataRevisionAfterRestore,
        expectedContentRevisionId: comicContentRevisionAfterAppend,
        deviceId: 'hosted-live-smoke',
      }),
    });
    await request(`/trash/books/${encodeURIComponent(fixedDocumentBookId)}`, {
      method: 'DELETE',
      ...jsonBody({
        expectedRevision: Number(trashedComic.metadataRevision),
        expectedContentRevisionId: comicContentRevisionAfterAppend,
      }),
    });
    await uploadSingleChunkBook({
      bookId: fixedDocumentBookId,
      fileName: `${fixedDocumentBookId}.cbz`,
      contentType: 'application/vnd.comicbook+zip',
      bytes: comicBytes,
    });
    const recreatedCatalogBook = await activeCatalogBook(fixedDocumentBookId);
    const recreatedContentRevisionId = String(
      bookField(recreatedCatalogBook, 'active_content_revision_id', 'activeContentRevisionId') ?? '',
    );
    assert(recreatedContentRevisionId, 'recreated comic catalog entry did not expose its content revision');
    const recreatedComicManifest = await request(
      `/books/${encodeURIComponent(fixedDocumentBookId)}/manifest?contentRevisionId=${encodeURIComponent(recreatedContentRevisionId)}`,
    );
    assert(
      recreatedContentRevisionId && recreatedContentRevisionId !== comicContentRevisionAfterAppend,
      'hard purge and re-import reused the deleted comic content generation',
    );
    const recreatedChapters = await request(
      `/books/${encodeURIComponent(fixedDocumentBookId)}/chapters?contentRevisionId=${encodeURIComponent(recreatedContentRevisionId)}`,
    );
    const recreatedFirstRelease = recreatedChapters.chapters?.find(
      (chapter) => chapter.document_section_id === firstReleaseId,
    );
    assert(recreatedFirstRelease?.id, 'recreated comic did not expose its first release');
    assert(
      recreatedChapters.chapters.every((chapter) => !chapter.document_section_read_at),
      'recreated comic inherited exact read markers from the purged generation',
    );
    const stalePosition = await request(`/books/${encodeURIComponent(fixedDocumentBookId)}/reading-position`, {
      method: 'PATCH',
      ...jsonBody({
        chapterId: recreatedFirstRelease.id,
        paragraphIndex: 0,
        offsetInParagraph: 0,
        chapterProgress: 0.1,
        scrollTop: 0,
        deviceId: 'hosted-live-smoke-stale-generation',
        documentSectionId: firstReleaseId,
        expectedContentRevisionId: comicContentRevisionAfterAppend,
        updatedAt: new Date().toISOString(),
      }),
    });
    assert(
      stalePosition.applied === false && stalePosition.reason === 'content_revision_changed',
      'recreated comic accepted a reading update from the purged generation',
    );
    const staleCoverResponse = await fetch(
      joinUrl(apiBaseUrl, `/books/${encodeURIComponent(fixedDocumentBookId)}/cover/approved-enrichment`),
      {
        method: 'PUT',
        headers: authHeaders({
          'Content-Type': 'application/octet-stream',
          'X-Cover-File-Name': encodeURIComponent(`${fixedDocumentBookId}-stale.png`),
          'X-Cover-Content-Type': 'image/png',
          'X-Cover-Content-Hash': sampleCoverHash,
          'X-Cover-Width': '1',
          'X-Cover-Height': '1',
          'X-Cover-Fit': 'crop',
          'X-Cover-Position-X': '50',
          'X-Cover-Position-Y': '50',
          'X-Expected-Metadata-Revision': String(
            bookField(recreatedComicManifest.book, 'metadata_revision', 'metadataRevision') ?? 0,
          ),
          'X-Expected-Content-Revision-Id': comicContentRevisionAfterAppend,
        }),
        body: sampleCoverBytes,
      },
    );
    assert(staleCoverResponse.status === 409, 'recreated comic accepted a cover from the purged generation');
    console.log('ok isolated a hard-purged comic generation from its deterministic-id replacement');

    const paragraphLookup = await request(`/paragraphs/${encodeURIComponent(firstParagraph.id)}`);
    assert(
      paragraphLookup.paragraph?.id === firstParagraph.id,
      'paragraph lookup did not return the first imported paragraph',
    );
    const chapterSearch = await request(
      `/chapters/${encodeURIComponent(firstChapter.id)}/search?query=${encodeURIComponent('first paragraph')}&limit=5`,
    );
    assert(
      chapterSearch.paragraphs?.some((paragraph) => paragraph.id === firstParagraph.id),
      'chapter search did not find the first imported paragraph',
    );
    const bookSearch = await request(
      `/books/${encodeURIComponent(importedBookId)}/search?query=${encodeURIComponent('hosted page api')}&limit=5`,
    );
    assert(
      bookSearch.paragraphs?.some(
        (paragraph) =>
          (paragraph.novelId === importedBookId || paragraph.bookId === importedBookId) &&
          paragraph.text?.toLocaleLowerCase().includes('hosted page api'),
      ),
      'book search did not find the second imported chapter paragraph',
    );
    console.log('ok looked up paragraph and searched imported hosted text');

    const position = {
      chapterId: firstChapter.id,
      paragraphId: firstParagraph.id,
      paragraphIndex: firstParagraph.index,
      offsetInParagraph: 0,
      chapterProgress: 0.25,
      scrollTop: 120,
      deviceId: 'hosted-live-smoke',
      expectedContentRevisionId: importedContentRevisionId,
      updatedAt: new Date().toISOString(),
    };
    const savedPosition = await request(`/books/${encodeURIComponent(importedBookId)}/reading-position`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(position),
    });
    assert(savedPosition.applied === true, 'reading position was not applied');
    console.log('ok saved hosted reading position');

    const bookmarkId = `${smokeId}_bookmark`;
    const highlightId = `${smokeId}_highlight`;
    const noteId = `${smokeId}_note`;
    const createdAt = new Date().toISOString();
    const updatedAt = new Date(Date.now() + 1000).toISOString();

    const bookmark = await request(`/books/${encodeURIComponent(importedBookId)}/bookmarks`, {
      method: 'POST',
      ...jsonBody({
        id: bookmarkId,
        chapterId: firstChapter.id,
        paragraphId: firstParagraph.id,
        label: 'Hosted smoke bookmark',
        progress: 0.25,
        scrollTop: 120,
        createdAt,
      }),
    });
    assert(bookmark.applied === true, 'bookmark create was not applied');
    const bookmarks = await request(`/books/${encodeURIComponent(importedBookId)}/bookmarks`);
    assert(
      bookmarks.bookmarks?.some((item) => item.id === bookmarkId),
      'bookmark list did not include smoke bookmark',
    );

    const highlight = await request(`/books/${encodeURIComponent(importedBookId)}/highlights`, {
      method: 'POST',
      ...jsonBody({
        id: highlightId,
        chapterId: firstChapter.id,
        paragraphId: firstParagraph.id,
        quote: firstParagraph.text ?? 'Hosted smoke highlight',
        color: 'yellow',
        progress: 0.25,
        createdAt,
        updatedAt: createdAt,
      }),
    });
    assert(highlight.applied === true, 'highlight create was not applied');
    const highlights = await request(`/books/${encodeURIComponent(importedBookId)}/highlights`);
    assert(
      highlights.highlights?.some((item) => item.id === highlightId),
      'highlight list did not include smoke highlight',
    );

    const note = await request(`/books/${encodeURIComponent(importedBookId)}/notes`, {
      method: 'POST',
      ...jsonBody({
        id: noteId,
        chapterId: firstChapter.id,
        paragraphId: firstParagraph.id,
        quote: firstParagraph.text ?? 'Hosted smoke note',
        body: 'Hosted smoke note',
        progress: 0.25,
        createdAt,
        updatedAt: createdAt,
      }),
    });
    assert(note.applied === true, 'note create was not applied');
    const noteUpdate = await request(`/books/${encodeURIComponent(importedBookId)}/notes`, {
      method: 'POST',
      ...jsonBody({
        id: noteId,
        chapterId: firstChapter.id,
        paragraphId: firstParagraph.id,
        quote: firstParagraph.text ?? 'Hosted smoke note',
        body: 'Hosted smoke note updated',
        progress: 0.5,
        createdAt,
        updatedAt,
      }),
    });
    assert(noteUpdate.applied === true, 'note update was not applied');
    const notes = await request(`/books/${encodeURIComponent(importedBookId)}/notes`);
    assert(
      notes.notes?.some((item) => item.id === noteId && item.body === 'Hosted smoke note updated'),
      'note list did not include updated smoke note',
    );
    console.log('ok created hosted bookmark, highlight, and note');

    await request(`/bookmarks/${encodeURIComponent(bookmarkId)}`, { method: 'DELETE' });
    await request(`/highlights/${encodeURIComponent(highlightId)}`, { method: 'DELETE' });
    await request(`/notes/${encodeURIComponent(noteId)}`, { method: 'DELETE' });
    const deletedBookmarks = await request(`/books/${encodeURIComponent(importedBookId)}/bookmarks`);
    const deletedHighlights = await request(`/books/${encodeURIComponent(importedBookId)}/highlights`);
    const deletedNotes = await request(`/books/${encodeURIComponent(importedBookId)}/notes`);
    assert(!deletedBookmarks.bookmarks?.some((item) => item.id === bookmarkId), 'deleted bookmark stayed visible');
    assert(!deletedHighlights.highlights?.some((item) => item.id === highlightId), 'deleted highlight stayed visible');
    assert(!deletedNotes.notes?.some((item) => item.id === noteId), 'deleted note stayed visible');
    console.log('ok deleted hosted bookmark, highlight, and note');

    const syncAfter = await pullSyncEventsSince(syncCursor);
    assertSyncEvent(
      syncAfter,
      'book_imported',
      (event, payload) =>
        event.book_id === importedBookId && event.entity_id === importedBookId && payload.bookId === importedBookId,
    );
    assertSyncEvent(
      syncAfter,
      'reading_position_updated',
      (event, payload) =>
        event.book_id === importedBookId &&
        event.entity_id === `reading_position_${importedBookId}` &&
        payload.position?.bookId === importedBookId,
    );
    assertSyncEvent(
      syncAfter,
      'bookmark_created',
      (event, payload) =>
        event.book_id === importedBookId && event.entity_id === bookmarkId && payload.bookmark?.id === bookmarkId,
    );
    assertSyncEvent(
      syncAfter,
      'highlight_created',
      (event, payload) =>
        event.book_id === importedBookId && event.entity_id === highlightId && payload.highlight?.id === highlightId,
    );
    assertSyncEvent(
      syncAfter,
      'note_created',
      (event, payload) => event.book_id === importedBookId && event.entity_id === noteId && payload.note?.id === noteId,
    );
    assertSyncEvent(
      syncAfter,
      'note_updated',
      (event, payload) =>
        event.book_id === importedBookId &&
        event.entity_id === noteId &&
        payload.note?.id === noteId &&
        payload.note?.body === 'Hosted smoke note updated',
    );
    assertSyncEvent(
      syncAfter,
      'bookmark_deleted',
      (event, payload) =>
        event.book_id === importedBookId && event.entity_id === bookmarkId && payload.id === bookmarkId,
    );
    assertSyncEvent(
      syncAfter,
      'highlight_deleted',
      (event, payload) =>
        event.book_id === importedBookId && event.entity_id === highlightId && payload.id === highlightId,
    );
    assertSyncEvent(
      syncAfter,
      'note_deleted',
      (event, payload) => event.book_id === importedBookId && event.entity_id === noteId && payload.id === noteId,
    );
    console.log('ok sync pull exposed import, reading-position, annotation, and tombstone events');
  } finally {
    if (fixedDocumentBookId && !keepBook) {
      await cleanupSmokeBook(fixedDocumentBookId);
      console.log('ok cleaned up fixed-document smoke book');
    }
    if (importedBookId && !keepBook) {
      await cleanupSmokeBook(importedBookId);
      console.log('ok cleaned up smoke book');
    }
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
