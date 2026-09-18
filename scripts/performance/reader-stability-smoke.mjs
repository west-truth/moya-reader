import assert from 'node:assert/strict';
import { build } from 'vite';
import { chromium } from 'playwright-core';

// Real reader components, synthetic content, a fresh browser, and no backend/user storage.
const bundle = await build({
  configFile: false,
  logLevel: 'error',
  build: {
    write: false,
    rollupOptions: {
      input: {
        text: 'scripts/performance/reader-position-fixture.mjs',
        comic: 'scripts/performance/comic-stability-fixture.mjs',
      },
    },
  },
});
const output = bundle.output;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.READER_UI_BROWSER_EXECUTABLE
    ? { executablePath: process.env.READER_UI_BROWSER_EXECUTABLE }
    : { channel: process.env.READER_UI_BROWSER_CHANNEL || 'chromium' }),
});
const evidence = [];
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await context.route('**/*', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/text' || path === '/comic') {
      const entry = output.find((asset) => asset.type === 'chunk' && asset.isEntry && asset.name === path.slice(1));
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html><head>${output
          .filter((asset) => asset.fileName.endsWith('.css'))
          .map((asset) => `<link rel="stylesheet" href="/${asset.fileName}">`)
          .join(
            '',
          )}</head><body><div id="root"></div><script type="module" src="/${entry.fileName}"></script></body></html>`,
      });
    }
    const asset = output.find((asset) => `/${asset.fileName}` === path);
    return asset
      ? route.fulfill({
          contentType:
            asset.type === 'chunk'
              ? 'application/javascript'
              : asset.fileName.endsWith('.css')
                ? 'text/css'
                : 'application/octet-stream',
          body: asset.type === 'chunk' ? asset.code : Buffer.from(asset.source),
        })
      : route.fulfill({ status: 404, body: '' });
  });
  const errors = [];
  const newPage = async () => {
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    return page;
  };
  const page = await newPage();
  await page.goto('http://reader.test/text?long=1&variable=1&resume=9000');
  await page.waitForFunction(
    () =>
      readerFixture.api()?.getAnchor()?.blockIndex === 9000 &&
      document.querySelector('[data-reader-layer="scroll"]').getAttribute('aria-busy') === 'false',
  );
  await page.evaluate(() => {
    globalThis.resumeAnchor = readerFixture.api().getAnchor();
    readerFixture.pausePages();
    readerFixture.setPageTransitionPending(true);
    readerFixture.setFlow('paginated');
  });
  await page.waitForFunction(() => readerFixture.api()?.flow === 'paginated');
  await page.evaluate(() => {
    globalThis.restoreResult = readerFixture.api().scrollToAnchor(resumeAnchor, 0, 'previous-page');
  });
  await page.waitForTimeout(400);
  const pending = await page.evaluate(() => ({
    pageVisibility: getComputedStyle(document.querySelector('[data-reader-layer="paginated"]')).visibility,
    scrollVisibility: getComputedStyle(document.querySelector('[data-reader-layer="scroll"]')).visibility,
    wrongWrites: readerFixture.writes.filter((write) => write.paragraphIndex < 8990),
  }));
  assert.equal(pending.pageVisibility, 'hidden');
  assert.equal(pending.scrollVisibility, 'visible');
  assert.deepEqual(pending.wrongWrites, []);
  const restored = await page.evaluate(async () => {
    const start = performance.now();
    readerFixture.resumePages();
    const success = await restoreResult;
    readerFixture.setPageTransitionPending(false);
    return { success, ms: Math.round(performance.now() - start), requests: [...readerFixture.pageRequests] };
  });
  assert.equal(restored.success, true);
  await page.waitForFunction(
    () => document.querySelector('[data-reader-layer="paginated"]').dataset.paginationReady === 'true',
  );
  const previous = await page.locator('.reader-paginated-page.is-current').evaluate((element) => ({
    start: [Number(element.dataset.pageStartIndex), Number(element.dataset.pageStartOffset)],
    end: [Number(element.dataset.pageEndIndex), Number(element.dataset.pageEndOffset)],
  }));
  assert.deepEqual(previous.end, [9000, 0]);
  assert.ok(previous.start[0] >= 8990);
  assert.ok(
    restored.requests.every((index) => index >= 74),
    'Resume must not read the chapter prefix',
  );
  await page.evaluate(() => {
    readerFixture.api().pageJump(1);
    readerFixture.api().pageJump(1);
    readerFixture.api().pageJump(-1);
    readerFixture.api().pageJump(-1);
  });
  await page.waitForTimeout(500);
  assert.deepEqual(
    await page.evaluate(() => {
      const a = readerFixture.api().getAnchor();
      return [a.blockIndex, a.offset];
    }),
    previous.start,
    'Rapid next/previous turns must reverse to the exact source boundary',
  );
  await page.evaluate(() => readerFixture.setFontSize(24));
  await page.waitForTimeout(350);
  assert.deepEqual(
    await page.evaluate(() => {
      const a = readerFixture.api().getAnchor();
      return [a.blockIndex, a.offset];
    }),
    previous.start,
    'Font changes must preserve the visible anchor',
  );
  assert.equal(await page.evaluate(() => readerFixture.writes.some((write) => write.paragraphIndex < 8990)), false);
  evidence.push({
    textDeepResume: restored,
    previousBoundary: previous,
    hiddenUntilReady: true,
    reversibleTurns: true,
  });
  await page.close();

  const direct = await newPage();
  await direct.goto('http://reader.test/text?long=1&resume=9000&paged=1');
  await direct.waitForFunction(
    () => document.querySelector('[data-reader-layer="paginated"]')?.dataset.paginationReady === 'true',
  );
  assert.equal(await direct.evaluate(() => readerFixture.api().getAnchor().blockIndex), 9000);
  await direct.waitForFunction(() => !readerFixture.pendingOpen());
  evidence.push({ directPaginatedResume: true });
  await direct.close();

  // Empty-alt EPUB images, paragraph boundaries, and an oversized single text block must remain reachable.
  for (const query of ['images=1&empty-images=1&resume=119&paged=1', 'single=1&resume=0&paged=1']) {
    const bounded = await newPage();
    await bounded.goto(`http://reader.test/text?${query}`);
    await bounded.waitForFunction(
      () => document.querySelector('[data-reader-layer="paginated"]')?.dataset.paginationReady === 'true',
    );
    for (const direction of [-1, 1, -1, 1]) {
      await bounded.evaluate((direction) => readerFixture.api().pageJump(direction), direction);
      await bounded.waitForTimeout(220);
      const fits = await bounded.evaluate(() => {
        const stage = document.querySelector('.reader-pagination-stage').getBoundingClientRect();
        return [...document.querySelectorAll('.reader-paginated-page.is-current [data-paragraph-id]')].every(
          (element) => {
            const rect = element.getBoundingClientRect();
            return rect.bottom <= stage.bottom + 2 && rect.top >= stage.top - 2;
          },
        );
      });
      assert.equal(fits, true, `Page content must fit after moving ${direction}: ${query}`);
    }
    if (query.startsWith('images')) {
      const anchor = await bounded.evaluate(() => readerFixture.api().getAnchor());
      assert.equal(anchor.blockIndex, 119);
      assert.equal(await bounded.locator('.reader-paginated-page.is-current img').count(), 1);
    }
    await bounded.evaluate(() => readerFixture.api().scrubTo(1));
    await bounded.waitForFunction(() => readerFixture.api().getLocation()?.progress === 1);
    await bounded.waitForFunction(() => readerFixture.writes.at(-1)?.chapterProgress === 1);
    await bounded.close();
  }
  evidence.push({ emptyImageAndOversizedParagraph: true });

  const comic = await newPage();
  await comic.goto('http://reader.test/comic');
  await comic.waitForSelector('.fixed-doc-viewport.is-continuous-seamless img');
  await comic.waitForTimeout(300);
  const geometry = await comic.evaluate(async () => {
    comicFixture.setDelay(600);
    const viewport = document.querySelector('.fixed-doc-viewport');
    let checks = 0;
    const anomalies = [];
    for (const direction of [1, 0, -1, 0]) {
      for (let frame = 0; frame < 42; frame++) {
        const center = viewport.getBoundingClientRect().top + viewport.clientHeight / 2;
        const row = [...viewport.querySelectorAll('[data-page-index]')].find((element) => {
          const rect = element.getBoundingClientRect();
          return rect.top <= center && rect.bottom > center;
        });
        const top = row?.getBoundingClientRect().top;
        const before = viewport.scrollTop;
        viewport.scrollTop += direction * 900;
        const intended = viewport.scrollTop - before;
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        if (row?.isConnected) {
          checks++;
          const error = row.getBoundingClientRect().top - top + intended;
          if (Math.abs(error) > 3) anomalies.push({ direction, frame, error, page: row.dataset.pageIndex });
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    return { checks, anomalies };
  });
  assert.ok(geometry.checks > 120);
  assert.deepEqual(geometry.anomalies, [], 'Late image measurements must not move the visible source row');
  evidence.push({ comicGeometry: geometry });
  await comic.close();

  const flow = await newPage();
  await flow.goto('http://reader.test/comic?long-comic=1&start=80');
  await flow.waitForFunction(() => document.querySelector('[data-page-index="80"] img')?.naturalWidth > 0);
  await flow.waitForTimeout(300);
  const entry = await flow.evaluate(() => {
    const viewport = document.querySelector('.fixed-doc-viewport');
    const rows = [...viewport.querySelectorAll('article[data-page-index]')];
    globalThis.flowRows = rows;
    globalThis.flowImage = document.querySelector('[data-page-index="80"] img');
    return {
      count: rows.length,
      top:
        document.querySelector('[data-page-index="80"]').getBoundingClientRect().top -
        viewport.getBoundingClientRect().top,
    };
  });
  assert.equal(entry.count, 200, 'Keep only the active episode shells in normal document flow');
  assert.ok(Math.abs(entry.top) < 3, `Resume must remain at page 80: ${entry.top}`);
  for (let index = 80; index <= 110; index++) {
    await flow.evaluate((i) => {
      const viewport = document.querySelector('.fixed-doc-viewport');
      const row = document.querySelector(`[data-page-index="${i}"]`);
      viewport.scrollTop += row.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    }, index);
    await flow.waitForFunction((i) => document.querySelector(`[data-page-index="${i}"] img`)?.naturalWidth > 0, index);
  }
  const retained = await flow.evaluate(() => ({
    sameRows: flowRows.every((row) => row.isConnected),
    sameImage: flowImage === document.querySelector('[data-page-index="80"] img'),
    firstPageLoads: comicFixture.requests.filter((id) => id.startsWith('p80:')).length,
  }));
  assert.deepEqual(retained, { sameRows: true, sameImage: true, firstPageLoads: 1 });
  // A failed destination image must not replace the entire episode with an error screen.
  await flow.evaluate(() => {
    comicFixture.failPage(160);
    const viewport = document.querySelector('.fixed-doc-viewport');
    viewport.scrollTop +=
      document.querySelector('[data-page-index="160"]').getBoundingClientRect().top -
      viewport.getBoundingClientRect().top;
  });
  await flow.getByText('Injected image failure', { exact: true }).waitFor();
  assert.equal(await flow.locator('.is-page-flow article').count(), 200);
  assert.equal(await flow.evaluate(() => flowImage.isConnected), true);
  await flow.getByRole('button', { name: '다음 회차', exact: true }).click();
  await flow.waitForFunction(() => document.querySelector('.is-page-flow article')?.dataset.pageIndex === '200');
  await flow.waitForFunction(() => document.querySelector('[data-page-index="200"] img')?.naturalWidth > 0);
  assert.equal(await flow.locator('.is-page-flow article').count(), 200);
  await flow.getByRole('button', { name: '이전 회차', exact: true }).click();
  await flow.waitForFunction(() => document.querySelector('.is-page-flow article')?.dataset.pageIndex === '0');
  await flow.waitForFunction(() => document.querySelector('[data-page-index="0"] img')?.naturalWidth > 0);
  await flow.setViewportSize({ width: 430, height: 932 });
  await flow.waitForTimeout(300);
  const resizeGap = await flow.evaluate(() => {
    const rows = [...document.querySelectorAll('.is-page-flow article')];
    return Math.max(
      ...rows
        .slice(1)
        .map((row, i) => Math.abs(row.getBoundingClientRect().top - rows[i].getBoundingClientRect().bottom)),
    );
  });
  assert.ok(resizeGap < 1, `Page shells must remain adjacent after resize: ${resizeGap}`);
  evidence.push({ longComicResume: entry, retainedBeyond20Pages: retained, imageFailureKeepsEpisode: true });
  await flow.close();

  const legacy = await newPage();
  await legacy.goto('http://reader.test/comic?legacy=1');
  await legacy.waitForSelector('.fixed-doc-viewport.is-continuous-seamless img');
  await legacy.waitForTimeout(500);
  const append = await legacy.evaluate(async () => {
    const current = document.querySelector('.fixed-doc-pages article.is-current img');
    const src = current.src;
    comicFixture.setCount(100);
    await new Promise((resolve) => setTimeout(resolve, 300));
    return {
      sameElement: current === document.querySelector('.fixed-doc-pages article.is-current img'),
      sameUrl: current.src === src,
    };
  });
  assert.deepEqual(append, { sameElement: true, sameUrl: true });
  const original = await legacy.locator('.fixed-doc-pages article.is-current img').getAttribute('src');
  await legacy.evaluate(() => comicFixture.replace());
  await legacy.waitForFunction((old) => {
    const img = document.querySelector('.fixed-doc-pages article.is-current img');
    return img && img.src !== old;
  }, original);
  evidence.push({ legacyAppendPreserved: append, replacementReloaded: true });
  await legacy.close();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(evidence, null, 2));
  await context.close();
} finally {
  await browser.close();
}
