import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { Page } from 'playwright-core';
import { MangayomiExtensionHost } from '../../apps/server/src/extensions/mangayomi/host';
import { EncryptedSourceCredentialVault } from '../../apps/server/src/extensions/source-credential-vault';
import { compatibilityHttp } from '../../apps/server/src/extensions/mangayomi/http';

export async function prepareMangayomiAppGate(root: string, output: string, options: { live?: boolean } = {}) {
  const bytes = await readFile(resolve(root, 'apps/server/src/extensions/mangayomi/fixtures/upstream/mangadex.js.txt'));
  if (
    createHash('sha256').update(bytes).digest('hex') !==
    '46369adf82b4eb14abcb6f6248a6deaaaea125c11a77a335791ef2e7a1ff49b3'
  )
    throw Error('upstream_fixture_changed');
  const file = resolve(output, 'mangadex.js');
  await writeFile(file, bytes);
  const calls: string[] = [];
  let png = Buffer.alloc(0);
  const fixtureTransport: typeof compatibilityHttp = async ({ url }) => {
    calls.push(url);
    const parsed = new URL(url);
    const work = {
      id: 'work',
      attributes: {
        title: { en: 'MangaDex App Fixture' },
        description: { en: 'Offline original source app test' },
        tags: [],
        status: 'completed',
      },
      relationships: [],
    };
    let data: unknown;
    if (parsed.hostname === 'images.example' && parsed.pathname === '/data/fixture/page.png')
      return { url, bytes: png, headers: {}, contentType: 'image/png', statusCode: 200 };
    if (parsed.hostname !== 'api.mangadex.org') throw Error('unexpected_fixture_request');
    if (parsed.pathname === '/manga') data = { data: parsed.searchParams.get('title') === 'missing' ? [] : [work] };
    else if (parsed.pathname === '/manga/work') data = { data: work };
    else if (parsed.pathname === '/manga/work/feed')
      data = {
        limit: 500,
        total: 1,
        data: [
          {
            id: 'chapter',
            attributes: { chapter: '1', title: 'Fixture chapter', publishAt: '2026-01-01' },
            relationships: [],
          },
        ],
      };
    else if (parsed.pathname === '/at-home/server/chapter')
      data = { baseUrl: 'https://images.example', chapter: { hash: 'fixture', data: ['page.png'] } };
    else throw Error('unexpected_fixture_request');
    return {
      url,
      bytes: Buffer.from(JSON.stringify(data)),
      headers: {},
      contentType: 'application/json',
      statusCode: 200,
    };
  };
  const transport: typeof compatibilityHttp = options.live
    ? async (input, signal, origins, maximum) => {
        if (calls.length >= 16) throw new Error('live_probe_request_limit');
        calls.push(input.url);
        return compatibilityHttp(input, signal, origins, maximum);
      }
    : fixtureTransport;
  const host = await MangayomiExtensionHost.open(
    resolve(output, 'mangayomi'),
    new EncryptedSourceCredentialVault(resolve(output, 'vault'), Buffer.alloc(32, 11)),
    transport,
  );
  return {
    host,
    file,
    calls,
    setImage: (bytes: Buffer) => {
      png = Buffer.from(bytes);
    },
  };
}
export async function runMangayomiAppGate(
  page: Page,
  fixture: Awaited<ReturnType<typeof prepareMangayomiAppGate>>,
  output: string,
  options: { live?: boolean } = {},
) {
  if (options.live) return runLiveMangayomiAppGate(page, fixture, output);
  page.on('response', async (response) => {
    if (response.url().includes('/api/') && response.status() >= 400)
      console.error('Mangayomi fixture API failure', response.status(), await response.text());
  });
  // A visible, owned page makes the reader screenshot meaningful; no upstream artwork is retained.
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 480;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#f4f0e4';
    ctx.fillRect(0, 0, 320, 480);
    ctx.fillStyle = '#29465b';
    ctx.fillRect(20, 20, 280, 200);
    ctx.fillStyle = '#77966d';
    ctx.fillRect(20, 240, 130, 170);
    ctx.fillStyle = '#c87b52';
    ctx.fillRect(170, 240, 130, 170);
    ctx.fillStyle = '#ffffff';
    ctx.font = '20px sans-serif';
    ctx.fillText('Original JS source', 40, 100);
    ctx.fillText('Moya reader fixture', 40, 140);
    ctx.fillStyle = '#29465b';
    ctx.font = '16px sans-serif';
    ctx.fillText('320 x 480 / locally generated', 35, 448);
    return canvas.toDataURL('image/png');
  });
  fixture.setImage(Buffer.from(dataUrl.split(',')[1], 'base64'));
  await page.getByRole('button', { name: '설정', exact: true }).first().click();
  await page.getByRole('tab', { name: /^익스텐션/ }).click();
  await page.getByRole('button', { name: 'Mangayomi JS 확장', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Mangayomi JS 확장 관리', exact: true });
  await panel.getByLabel('Mangayomi JS 확장 파일', { exact: true }).setInputFiles(fixture.file);
  await panel.getByLabel('파일의 소스 선택').selectOption('10');
  const review = panel.getByRole('region', { name: 'Mangayomi JS 설치 확인', exact: true });
  await review.getByLabel('신뢰하는 확장입니다').check();
  await review.getByRole('button', { name: '설치', exact: true }).click();
  await panel.getByRole('button', { name: '끄기', exact: true }).waitFor();
  await panel.getByRole('button', { name: '설정', exact: true }).click();
  const languages = panel.getByLabel('Filter original languages', { exact: true });
  await languages.selectOption(['originalLanguage[]=ko', 'originalLanguage[]=ja']);
  await panel.getByRole('button', { name: '설정 저장', exact: true }).click();
  await panel.getByText('저장했습니다.', { exact: true }).waitFor();
  await page.screenshot({ path: resolve(output, 'mangayomi-preferences.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await page
    .getByRole('navigation', { name: '연결된 외부 소스' })
    .getByRole('button', { name: /MangaDex/ })
    .click();
  const work = page.getByRole('button', { name: 'MangaDex App Fixture 작품 상세 열기', exact: true });
  await work.waitFor();
  if (
    !fixture.calls.some((url) =>
      ['ko', 'ja'].every((lang) => new URL(url).searchParams.getAll('originalLanguage[]').includes(lang)),
    )
  )
    throw Error('saved_language_not_applied');
  await page.locator('.source-hub-catalog-search input').fill('missing');
  await page.locator('.source-hub-catalog-search').getByRole('button', { name: '검색', exact: true }).click();
  await work.waitFor({ state: 'detached' });
  await page.locator('.source-hub-catalog-search input').fill('Fixture');
  await page.locator('.source-hub-catalog-search').getByRole('button', { name: '검색', exact: true }).click();
  await work.waitFor();
  await work.click();
  await page.locator('.source-hub-release-row').first().waitFor();
  await page.getByLabel('이 페이지 선택', { exact: true }).check();
  await page.getByRole('button', { name: '선택 회차 다운로드', exact: true }).click();
  const imported = page.locator('.source-hub-release-row[data-state="imported"]');
  await imported.first().waitFor({ timeout: 30000 });
  await imported.getByRole('button', { name: 'Ch.1 Fixture chapter 보기', exact: true }).click();
  await page.locator('.fixed-doc-screen').waitFor();
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll<HTMLImageElement>('.fixed-doc-screen img')).some(
      (img) => img.complete && img.naturalWidth === 320 && img.naturalHeight === 480,
    ),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: resolve(output, 'mangayomi-reader-390.png'), fullPage: true });
  if (!fixture.calls.some((url) => url.endsWith('/page.png'))) throw Error('image_not_downloaded');
  await page.setViewportSize({ width: 1366, height: 1000 });
  await page.reload();
  await page
    .getByRole('navigation', { name: '연결된 외부 소스' })
    .getByRole('button', { name: /MangaDex/ })
    .click();
  await work.click();
  await imported.getByRole('button', { name: 'Ch.1 Fixture chapter 보기', exact: true }).click();
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll<HTMLImageElement>('.fixed-doc-screen img')).some(
      (img) => img.complete && img.naturalWidth === 320 && img.naturalHeight === 480,
    ),
  );
  if (fixture.calls.filter((url) => url.endsWith('/page.png')).length !== 1)
    throw Error('reopen_redownloaded_imported_image');

  const pkg = fixture.host.snapshot().packages[0].pkg;
  const fields = fixture.host.preferences(pkg).fields;
  if (
    JSON.stringify([...(fields.find((f) => f.key === 'original_languages')?.value as string[])].sort()) !==
    JSON.stringify(['originalLanguage[]=ja', 'originalLanguage[]=ko'])
  )
    throw Error('preferences_not_saved');
  console.log(
    JSON.stringify({
      passed: true,
      target: 'hosted Mangayomi original + deterministic offline HTTP',
      coverage:
        'UI file import/language selection, multiple preferences, catalog search, chapter download, comic reader image decode, reload/reopen without redownload',
      output,
    }),
  );
}

async function runLiveMangayomiAppGate(
  page: Page,
  fixture: Awaited<ReturnType<typeof prepareMangayomiAppGate>>,
  output: string,
) {
  await page.getByRole('button', { name: '설정', exact: true }).first().click();
  await page.getByRole('tab', { name: /^익스텐션/ }).click();
  await page.getByRole('button', { name: 'Mangayomi JS 확장', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Mangayomi JS 확장 관리', exact: true });
  await panel.getByLabel('Mangayomi JS 확장 파일', { exact: true }).setInputFiles(fixture.file);
  await panel.getByLabel('파일의 소스 선택').selectOption('10');
  const review = panel.getByRole('region', { name: 'Mangayomi JS 설치 확인', exact: true });
  await review.getByLabel('신뢰하는 확장입니다').check();
  await review.getByRole('button', { name: '설치', exact: true }).click();
  await panel.getByRole('button', { name: '끄기', exact: true }).waitFor();
  await panel.getByRole('button', { name: '설정', exact: true }).click();
  await panel.getByLabel('Filter original languages', { exact: true }).selectOption(['originalLanguage[]=ko']);
  await panel.getByRole('button', { name: '설정 저장', exact: true }).click();
  await panel.getByText('저장했습니다.', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page
    .getByRole('navigation', { name: '연결된 외부 소스' })
    .getByRole('button', { name: /MangaDex/ })
    .click();
  const search = page.locator('.source-hub-catalog-search');
  await search.locator('input').fill('The Greatest Estate Developer');
  await search.getByRole('button', { name: '검색', exact: true }).click();
  const work = page.getByRole('button', { name: 'The Greatest Estate Developer 작품 상세 열기', exact: true });
  await work.waitFor({ timeout: 30_000 });
  await work.click();
  // The live fixture title currently exposes two unavailable regular chapters and one public
  // April-folklore chapter. Pick the latter explicitly so the gate verifies content bytes.
  const release = page.locator('.source-hub-release-row').filter({ hasText: 'A Laborer (April Folklore)' });
  await release.waitFor({ timeout: 30_000 });
  await release.getByLabel('Ch.223.9 A Laborer (April Folklore) 선택', { exact: true }).check();
  await page.getByRole('button', { name: '선택 회차 다운로드', exact: true }).click();
  const imported = page
    .locator('.source-hub-release-row[data-state="imported"]')
    .filter({ hasText: 'A Laborer (April Folklore)' });
  await imported.waitFor({ timeout: 60_000 });
  await imported.getByRole('button', { name: 'Ch.223.9 A Laborer (April Folklore) 보기', exact: true }).click();
  await page.locator('.fixed-doc-screen').waitFor({ timeout: 30_000 });
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll<HTMLImageElement>('.fixed-doc-screen img')).some(
      (image) => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0,
    ),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: resolve(output, 'mangayomi-live-reader-390.png'), fullPage: true });
  if (!fixture.calls.some((url) => url.includes('api.mangadex.org'))) throw Error('live_api_not_called');
  console.log(
    JSON.stringify({
      passed: true,
      target: 'hosted original MangaDex + live read-only API',
      coverage: 'UI file import, live search/detail/chapter download and mobile comic reader decode',
      requests: fixture.calls.length,
      output,
    }),
  );
}
