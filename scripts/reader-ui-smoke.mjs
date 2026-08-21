import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2).filter((arg) => arg !== '--');

function hasArg(name) {
  return args.includes(name);
}

function argValue(name, fallback) {
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  return fallback;
}

const baseUrl = argValue('--url', process.env.READER_UI_SMOKE_URL ?? 'http://127.0.0.1:1420');
const explicitChannel = argValue('--channel', process.env.READER_UI_BROWSER_CHANNEL ?? '');
const timeoutMs = Number(argValue('--timeout-ms', process.env.READER_UI_SMOKE_TIMEOUT_MS ?? '45000'));
const headed = hasArg('--headed');
const keepServer = hasArg('--keep-server');
const skipScreenshots = hasArg('--no-screenshots');
const novelFile = argValue('--novel-file', process.env.READER_UI_NOVEL_FILE ?? '');
let importedChapterCount = 0;
const screenshotDir = path.resolve(
  argValue('--screenshots-dir', process.env.READER_UI_SCREENSHOT_DIR ?? 'screenshots'),
);

function log(message) {
  console.log(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isReachable(url) {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForReachable(url, deadlineMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < deadlineMs) {
    if (await isReachable(url)) return;
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function startDevServer() {
  log('\n$ pnpm dev');
  const child = spawn('pnpm', ['dev'], {
    cwd: process.cwd(),
    env: process.env,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  return child;
}

async function stopDevServer(server) {
  if (server.exitCode !== null || server.killed) return;
  if (process.platform !== 'win32') {
    server.kill('SIGTERM');
    return;
  }
  await new Promise((resolve) => {
    const killer = spawn('taskkill', ['/pid', String(server.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.once('error', resolve);
    killer.once('exit', resolve);
  });
}

async function withServer(callback) {
  if (await isReachable(baseUrl)) {
    log(`Using existing dev server at ${baseUrl}`);
    return callback();
  }

  const server = startDevServer();
  try {
    await waitForReachable(baseUrl, timeoutMs);
    return await callback();
  } finally {
    if (keepServer) {
      log('Keeping dev server running.');
    } else {
      await stopDevServer(server);
    }
  }
}

async function launchBrowser() {
  const channels = explicitChannel ? [explicitChannel] : ['msedge', 'chrome', 'chromium'];
  const errors = [];
  for (const channel of channels) {
    try {
      const browser = await chromium.launch({ channel, headless: !headed });
      log(`Using browser channel: ${channel}`);
      return browser;
    } catch (error) {
      errors.push(`${channel}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    }
  }
  throw new Error(
    `Could not launch Edge/Chrome for reader UI smoke. Set READER_UI_BROWSER_CHANNEL or install a Playwright-compatible browser.\n${errors.join('\n')}`,
  );
}

async function screenshot(page, name) {
  if (skipScreenshots) return;
  await fs.mkdir(screenshotDir, { recursive: true });
  await page.screenshot({ path: path.join(screenshotDir, `${name}.png`), fullPage: true });
}

async function assertVisible(page, selector, label) {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: 'visible', timeout: timeoutMs });
  const box = await locator.boundingBox();
  if (!box || box.width < 1 || box.height < 1) throw new Error(`${label} is not visibly rendered`);
}

async function assertNoHorizontalOverflow(page, label) {
  const issues = await page.evaluate(() => {
    const selectors = [
      '.app-header',
      '.reader-topbar',
      '.reader-bottombar',
      '.reader-document',
      '.reader-scroll',
      '.settings-panel',
      '.addon-panel',
      '.search-result-strip',
    ];
    const viewportWidth = document.documentElement.clientWidth;
    const visible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    return selectors.flatMap((selector) =>
      Array.from(document.querySelectorAll(selector))
        .filter(visible)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const overflowsViewport = rect.left < -2 || rect.right > viewportWidth + 2;
          const overflowsSelf = element.scrollWidth > element.clientWidth + 2;
          return overflowsViewport || overflowsSelf
            ? {
                selector,
                left: Math.round(rect.left),
                right: Math.round(rect.right),
                viewportWidth,
                clientWidth: element.clientWidth,
                scrollWidth: element.scrollWidth,
              }
            : undefined;
        })
        .filter(Boolean),
    );
  });
  if (issues.length) {
    throw new Error(`${label} has horizontal overflow: ${JSON.stringify(issues.slice(0, 5))}`);
  }
}

async function assertReaderDomIsBounded(page) {
  const counts = await page.evaluate(() => {
    const active = document.querySelector('.reader-viewport-layer.is-active');
    return {
      paragraphs: active?.querySelectorAll('.reader-paragraph').length ?? 0,
      rows: active?.querySelectorAll('.reader-virtual-row').length ?? 0,
    };
  });
  if (counts.paragraphs < 1) throw new Error('Reader rendered no visible paragraphs');
  if (counts.rows > 45 || counts.paragraphs > 45) {
    throw new Error(`Reader rendered too many virtual rows: ${JSON.stringify(counts)}`);
  }
}

async function openSampleReader(page) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await page.getByRole('button', { name: /샘플 추가/ }).click({ timeout: timeoutMs });
  await page.getByText('샘플: 돌아온 밤').first().waitFor({ state: 'visible', timeout: timeoutMs });
  await page.getByRole('button', { name: '이어 읽기' }).first().click({ timeout: timeoutMs });
  await page.getByPlaceholder('본문 검색').waitFor({ state: 'visible', timeout: timeoutMs });
  await page.locator('.reader-paragraph').first().waitFor({ state: 'visible', timeout: timeoutMs });
}

async function openImportedNovelReader(page, filePath) {
  await fs.access(filePath);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await page.getByRole('button', { name: '책 가져오기', exact: true }).click({ timeout: timeoutMs });
  await page.locator('input[type="file"]').setInputFiles(filePath);
  await page.getByRole('button', { name: '가져오기 시작', exact: true }).click();
  const continueReading = page.getByRole('button', { name: '이어 읽기', exact: true }).first();
  await continueReading.waitFor({ state: 'visible', timeout: Math.max(timeoutMs, 120_000) });
  const chapterCandidates = page
    .getByRole('region', { name: '화 목록' })
    .getByRole('button')
    .filter({ hasText: '문단' });
  importedChapterCount = await chapterCandidates.count();
  let selectedChapter = -1;
  let largestParagraphCount = -1;
  for (let index = 0; index < importedChapterCount; index += 1) {
    const text = await chapterCandidates.nth(index).innerText();
    const paragraphCount = Number((text.match(/([\d,]+)문단/u)?.[1] ?? '0').replaceAll(',', ''));
    if (paragraphCount > largestParagraphCount) {
      largestParagraphCount = paragraphCount;
      selectedChapter = index;
    }
  }
  if (selectedChapter >= 0 && largestParagraphCount > 0) await chapterCandidates.nth(selectedChapter).click();
  else await continueReading.click();
  await page.getByPlaceholder('본문 검색').waitFor({ state: 'visible', timeout: timeoutMs });
  await page.locator('.reader-paragraph').first().waitFor({ state: 'visible', timeout: timeoutMs });
}

async function openReader(page) {
  if (novelFile) {
    log(`Testing real novel: ${path.basename(novelFile)}`);
    await openImportedNovelReader(page, path.resolve(novelFile));
    return;
  }
  await openSampleReader(page);
}

async function assertPaginatedPageFitsViewport(page, label) {
  const layout = await page.evaluate(() => {
    const root = document.querySelector('.reader-paginated-root.is-active');
    const stage = root?.querySelector('.reader-pagination-stage');
    const pageElement = root?.querySelector('.reader-paginated-page.is-current');
    if (!(root instanceof HTMLElement) || !(stage instanceof HTMLElement) || !(pageElement instanceof HTMLElement)) {
      return { missing: true };
    }
    const rootRect = root.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const blocks = [...pageElement.querySelectorAll('[data-reader-chapter-heading], [data-paragraph-id]')].map(
      (element) => {
        const rect = element.getBoundingClientRect();
        return {
          id: element.getAttribute('data-paragraph-id') ?? 'chapter-heading',
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
          text: element.textContent?.trim().slice(0, 40),
        };
      },
    );
    const clippedBlocks = blocks.filter(
      (block) => block.top < stageRect.top - 1 || block.bottom > stageRect.bottom + 1,
    );
    const contentBottom = blocks.reduce((bottom, block) => Math.max(bottom, block.bottom), Math.round(stageRect.top));
    return {
      missing: false,
      rootHeight: rootRect.height,
      stageHeight: stageRect.height,
      stageTop: Math.round(stageRect.top),
      stageBottom: Math.round(stageRect.bottom),
      clipped: clippedBlocks.length > 0,
      clippedBlocks,
      contentFillRatio: stageRect.height > 0 ? (contentBottom - stageRect.top) / stageRect.height : 0,
    };
  });
  if (layout.missing || layout.clipped || layout.stageHeight < layout.rootHeight * 0.55) {
    throw new Error(`${label} has a clipped or undersized page stage: ${JSON.stringify(layout)}`);
  }
  return layout;
}

async function waitForPaginatedPageFit(page, label, maxWaitMs = 1_500) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt <= maxWaitMs) {
    try {
      await assertPaginatedPageFitsViewport(page, label);
      const elapsed = Date.now() - startedAt;
      log(`${label} layout settled in ${elapsed}ms`);
      return elapsed;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(25);
    }
  }
  throw lastError;
}

async function currentPageStart(page) {
  return page.locator('.reader-paginated-page.is-current').evaluate((element) => ({
    index: Number(element.getAttribute('data-page-start-index') ?? -1),
    offset: Number(element.getAttribute('data-page-start-offset') ?? 0),
  }));
}

async function assertChapterHeading(page, label) {
  const heading = page.locator('.reader-paginated-page.is-current [data-reader-chapter-heading]');
  await heading.waitFor({ state: 'visible', timeout: timeoutMs });
  const content = (await heading.innerText()).trim();
  if (!/^제\s+\d+화/mu.test(content) || !(await heading.locator('h1').innerText()).trim()) {
    throw new Error(`${label} does not show both the chapter sequence and title: ${JSON.stringify(content)}`);
  }
}

async function assertScrollChapterBoundary(browser) {
  log('Checking deliberate scroll-end next-chapter gesture');
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  try {
    await openSampleReader(page);
    const root = page.locator('[data-reader-layer="scroll"].is-active');
    const titleBefore = await page.locator('.reader-title span').innerText();
    const nextButton = root.locator('.chapter-nav button').filter({ hasText: '다음 화' });
    if (await nextButton.isDisabled()) throw new Error('Sample reader has no next chapter for boundary verification');
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await root.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(120);
    if ((await page.locator('.reader-title span').innerText()) !== titleBefore) {
      throw new Error('Reaching the scroll end immediately changed chapter');
    }
    const boundary = page.locator('[data-scroll-chapter-boundary="true"]');
    await page.waitForFunction(
      () =>
        document.querySelector('[data-scroll-chapter-boundary]')?.getAttribute('data-scroll-chapter-boundary-armed') ===
        'true',
      undefined,
      { timeout: 1_500 },
    );
    log('Scroll chapter boundary armed for wheel input');
    await root.dispatchEvent('wheel', { deltaY: 40, deltaMode: 0 });
    await page.waitForTimeout(90);
    if ((await page.locator('.reader-title span').innerText()) !== titleBefore) {
      throw new Error('A weak boundary wheel changed chapter');
    }
    if ((await boundary.getAttribute('data-scroll-chapter-boundary-armed')) !== 'true') {
      throw new Error('A weak boundary wheel unexpectedly disarmed the next-chapter gesture');
    }
    const weakPull = await root.locator('.reader-document').evaluate((element) => ({
      className: element.className,
      transform: getComputedStyle(element).transform,
    }));
    if (!weakPull.className.includes('is-wheel-pull') || weakPull.transform === 'none') {
      throw new Error(`A weak boundary wheel did not move the end content: ${JSON.stringify(weakPull)}`);
    }
    await page.waitForTimeout(320);
    const releasedPull = await root
      .locator('.reader-document')
      .evaluate((element) => getComputedStyle(element).transform);
    if (releasedPull !== 'none' && releasedPull !== 'matrix(1, 0, 0, 1, 0, 0)') {
      throw new Error(`A weak boundary wheel did not spring back: ${JSON.stringify(releasedPull)}`);
    }
    log('Weak wheel pull released without changing chapter');
    await root.dispatchEvent('wheel', { deltaY: 100, deltaMode: 0 });
    log('Strong wheel input dispatched');
    await page.waitForFunction(
      (previousTitle) => document.querySelector('.reader-title span')?.textContent?.trim() !== previousTitle,
      titleBefore.trim(),
      { timeout: timeoutMs },
    );
    log('Strong wheel input changed chapter');
    await page.locator('[data-reader-layer="scroll"].is-active [data-reader-chapter-heading]').waitFor({
      state: 'visible',
      timeout: timeoutMs,
    });
    const chapterStart = await page.evaluate(() => ({
      progress: document.querySelector('.progress-label')?.textContent?.trim(),
      scrollTop: document.querySelector('[data-reader-layer="scroll"].is-active')?.scrollTop,
    }));
    if (chapterStart.progress !== '0%' || (chapterStart.scrollTop ?? Number.POSITIVE_INFINITY) > 1) {
      throw new Error(`Next chapter did not open at a clean start: ${JSON.stringify(chapterStart)}`);
    }

    const secondTitle = await page.locator('.reader-title span').innerText();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(150);
    const secondRoot = page.locator('[data-reader-layer="scroll"].is-active');
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await secondRoot.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await page.waitForTimeout(100);
    }
    await page.waitForFunction(
      () =>
        document.querySelector('[data-scroll-chapter-boundary]')?.getAttribute('data-scroll-chapter-boundary-armed') ===
        'true',
      undefined,
      { timeout: 1_500 },
    );
    log('Scroll chapter boundary armed for touch input');
    await secondRoot.dispatchEvent('pointerdown', {
      pointerId: 21,
      pointerType: 'touch',
      clientX: 195,
      clientY: 620,
    });
    await secondRoot.dispatchEvent('pointermove', {
      pointerId: 21,
      pointerType: 'touch',
      clientX: 195,
      clientY: 540,
    });
    await page.waitForTimeout(40);
    const touchPull = await secondRoot.locator('.reader-document').evaluate((element) => ({
      className: element.className,
      transform: getComputedStyle(element).transform,
    }));
    if (!touchPull.className.includes('is-touch-pull') || touchPull.transform === 'none') {
      throw new Error(`Touch boundary gesture did not follow the pointer: ${JSON.stringify(touchPull)}`);
    }
    await secondRoot.dispatchEvent('pointerup', {
      pointerId: 21,
      pointerType: 'touch',
      clientX: 195,
      clientY: 540,
    });
    log('Strong touch input dispatched');
    await page.waitForFunction(
      (previousTitle) => document.querySelector('.reader-title span')?.textContent?.trim() !== previousTitle,
      secondTitle.trim(),
      { timeout: timeoutMs },
    );
    log('Strong touch input changed chapter');
    const touchChapterStart = await page.evaluate(() => ({
      progress: document.querySelector('.progress-label')?.textContent?.trim(),
      scrollTop: document.querySelector('[data-reader-layer="scroll"].is-active')?.scrollTop,
    }));
    if (touchChapterStart.progress !== '0%' || (touchChapterStart.scrollTop ?? Number.POSITIVE_INFINITY) > 1) {
      throw new Error(
        `Touch boundary gesture did not open a clean chapter start: ${JSON.stringify(touchChapterStart)}`,
      );
    }
  } finally {
    await context.close();
  }
}

async function runReaderSmoke() {
  const browser = await launchBrowser();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    const text = message.text();
    if (
      message.type() === 'error' &&
      !text.includes('Failed to load resource: the server responded with a status of 404')
    ) {
      browserErrors.push(text);
    }
  });

  try {
    await openReader(page);
    await assertVisible(page, '.reader-topbar', 'desktop reader topbar');
    await assertReaderDomIsBounded(page);
    await assertNoHorizontalOverflow(page, 'desktop reader');
    await screenshot(page, 'reader-ui-smoke-desktop');

    await page.getByPlaceholder('본문 검색').fill('빗소리');
    await page
      .getByText(/현재 화 검색|결과/)
      .first()
      .waitFor({ state: 'visible', timeout: timeoutMs });
    await assertNoHorizontalOverflow(page, 'desktop reader search');

    await page.getByPlaceholder('본문 검색').fill('');
    const chapterBeforePageIntent = await page.locator('.reader-title span').innerText();
    const lastFullyVisibleBlock = await page.evaluate(() => {
      const root = document.querySelector('[data-reader-layer="scroll"].is-active');
      if (!(root instanceof HTMLElement)) return -1;
      const style = getComputedStyle(root);
      const rootRect = root.getBoundingClientRect();
      const top = rootRect.top + (Number.parseFloat(style.paddingTop) || 0);
      const bottom = rootRect.bottom - (Number.parseFloat(style.paddingBottom) || 0);
      return [...root.querySelectorAll('[data-index]')].reduce((last, row) => {
        const paragraph = row.querySelector('[data-paragraph-id]');
        const rect = paragraph?.getBoundingClientRect();
        const readable = paragraph?.textContent?.replace(/[\s\u200b-\u200d\u2060\ufeff]/gu, '');
        return rect && readable && rect.top >= top - 1 && rect.bottom <= bottom + 1
          ? Math.max(last, Number(row.getAttribute('data-index') ?? -1))
          : last;
      }, -1);
    });
    const paragraphProgress = await page.locator('.paragraph-progress-label').innerText();
    const paragraphCount = Number((paragraphProgress.match(/\/\s*([\d,]+)/u)?.[1] ?? '0').replaceAll(',', ''));
    log('Checking automatic scroll-to-page transition');
    await page.locator('[data-reader-layer="scroll"].is-active').press('PageDown');
    await page.locator('.reader-paginated-root.is-active').waitFor({ state: 'visible', timeout: timeoutMs });
    await page.waitForTimeout(500);
    const automaticLayout = await assertPaginatedPageFitsViewport(page, 'automatic paginated reader');
    await screenshot(page, 'reader-ui-smoke-scroll-to-page');
    const automaticPageIndicator = await page.locator('.reader-pagination-controls').innerText();
    const chapterAfterPageIntent = await page.locator('.reader-title span').innerText();
    const transitionStart = await page.locator('.reader-paginated-page.is-current').evaluate((element) => ({
      index: Number(element.getAttribute('data-page-start-index') ?? -1),
      offset: Number(element.getAttribute('data-page-start-offset') ?? 0),
    }));
    const transitionAnchor = {
      index: Number(await page.locator('.reader-screen').getAttribute('data-flow-transition-anchor')),
      offset: Number(await page.locator('.reader-screen').getAttribute('data-flow-transition-offset')),
    };
    if (paragraphCount > 20 && transitionStart.index < paragraphCount - 1 && automaticLayout.contentFillRatio < 0.55) {
      throw new Error(`Scroll-to-page left most of the reading frame empty: ${JSON.stringify(automaticLayout)}`);
    }
    if (
      chapterAfterPageIntent === chapterBeforePageIntent &&
      (transitionStart.index !== transitionAnchor.index || transitionStart.offset !== transitionAnchor.offset)
    ) {
      throw new Error(
        `Scroll-to-page did not begin at its exact continuation anchor: ${JSON.stringify({ transitionStart, transitionAnchor, automaticPageIndicator })}`,
      );
    }

    if (novelFile && importedChapterCount > 1) {
      log('Checking real-novel previous/next chapter boundary');
      await page.keyboard.press('Home');
      await page.waitForFunction(
        () =>
          document.querySelector('.reader-paginated-page.is-current')?.getAttribute('data-page-start-index') === '0',
        undefined,
        { timeout: timeoutMs },
      );
      const chapterBeforeBoundary = await page.locator('.reader-title span').innerText();
      await page.keyboard.press('PageUp');
      await page.waitForFunction(
        (previousTitle) => document.querySelector('.reader-title span')?.textContent?.trim() !== previousTitle,
        chapterBeforeBoundary.trim(),
        { timeout: timeoutMs },
      );
      await page.locator('.reader-paginated-root.is-active').waitFor({ state: 'visible', timeout: timeoutMs });
      await page.locator('.reader-paginated-page.is-current .reader-paragraph').first().waitFor({
        state: 'visible',
        timeout: timeoutMs,
      });
      await assertChapterHeading(page, 'next chapter first page');
      await page.keyboard.press('End');
      await page.keyboard.press('PageDown');
      await page.waitForFunction(
        (expectedTitle) => document.querySelector('.reader-title span')?.textContent?.trim() === expectedTitle,
        chapterBeforeBoundary.trim(),
        { timeout: timeoutMs },
      );
      await page.locator('.reader-paginated-page.is-current .reader-paragraph').first().waitFor({
        state: 'visible',
        timeout: timeoutMs,
      });
    }
    if (
      chapterAfterPageIntent === chapterBeforePageIntent &&
      lastFullyVisibleBlock < paragraphCount - 1 &&
      (transitionStart.index < lastFullyVisibleBlock ||
        (transitionStart.index === lastFullyVisibleBlock && transitionStart.offset === 0))
    ) {
      throw new Error(
        `Scroll-to-page repeated already-read blocks: ${JSON.stringify({
          lastFullyVisibleBlock,
          transitionStart,
          transitionAnchor,
          chapterBeforePageIntent,
          chapterAfterPageIntent,
          paragraphCount,
        })}`,
      );
    }

    await page.getByRole('button', { name: '읽기 설정 열기' }).click();
    await page.getByRole('heading', { name: '설정', exact: true }).waitFor({ state: 'visible', timeout: timeoutMs });
    await assertNoHorizontalOverflow(page, 'desktop settings panel');
    await page.getByRole('tab', { name: '조판', exact: true }).click();
    const modeLock = page.getByLabel('모드 잠금');
    if ((await modeLock.getByRole('button').count()) !== 3) {
      throw new Error('Reader settings must expose auto, scroll, and page locks');
    }
    if ((await modeLock.getByRole('button', { name: '자동', exact: true }).getAttribute('aria-pressed')) !== 'true') {
      throw new Error('Automatic page intent unexpectedly changed the persisted mode lock');
    }
    await page.getByLabel('페이지 이동 효과').getByRole('button', { name: '부드럽게', exact: true }).click();
    await screenshot(page, 'reader-ui-smoke-settings');
    await page.getByRole('button', { name: '설정 닫기' }).click();
    log('Checking automatic page navigation and wheel-to-scroll transition');
    await page.locator('.reader-paginated-root.is-active').waitFor({ state: 'visible', timeout: timeoutMs });
    await page
      .locator('.reader-pagination-controls')
      .getByText(/\d+ \/ (\d+|계산 중)/)
      .waitFor({
        state: 'visible',
        timeout: timeoutMs,
      });
    if (paragraphCount > 20) {
      await page.keyboard.press('PageDown');
      await page.waitForTimeout(220);
      await assertVisible(page, '.reader-paginated-page.is-current .reader-paragraph', 'paginated reader page');
      await page.keyboard.press('PageUp');
      await page.waitForTimeout(220);
      await page.keyboard.press('PageDown');
    }
    const automaticPageStartIndex = Number(
      await page.locator('.reader-screen').getAttribute('data-flow-transition-anchor'),
    );
    const automaticPageStartId =
      (await page.locator('.reader-paginated-page.is-current').getAttribute('data-page-start-id')) ?? '';
    const pageContentFrame = { top: automaticLayout.stageTop, bottom: automaticLayout.stageBottom };
    await screenshot(page, 'reader-ui-smoke-before-page-to-scroll-reverse');
    await page.evaluate(() => {
      const samples = [];
      window.__readerFlowSwapSamples = samples;
      let frame = 0;
      const capture = () => {
        const screen = document.querySelector('.reader-screen');
        const paginated = document.querySelector('.reader-paginated-root');
        const scroll = document.querySelector('[data-reader-layer="scroll"]');
        samples.push({
          frame,
          settling: screen?.getAttribute('data-flow-transition-settling') === 'true',
          pageVisibility: paginated ? getComputedStyle(paginated).visibility : 'missing',
          scrollVisibility: scroll ? getComputedStyle(scroll).visibility : 'missing',
          scrollTop: scroll instanceof HTMLElement ? scroll.scrollTop : Number.NaN,
        });
        frame += 1;
        if (frame < 24) requestAnimationFrame(capture);
      };
      requestAnimationFrame(capture);
    });
    await page.locator('.reader-paginated-root.is-active').dispatchEvent('wheel', { deltaY: -240 });
    await page.locator('[data-reader-layer="scroll"].is-active').waitFor({ state: 'visible', timeout: timeoutMs });
    await page.waitForTimeout(220);
    const flowSwapSamples = await page.evaluate(() => window.__readerFlowSwapSamples ?? []);
    const settlingSamples = flowSwapSamples.filter((sample) => sample.settling);
    const reverseSamples = flowSwapSamples
      .filter((sample) => !sample.settling && sample.scrollVisibility === 'visible')
      .map((sample) => sample.scrollTop);
    if (
      settlingSamples.length === 0 ||
      settlingSamples.some((sample) => sample.pageVisibility !== 'visible' || sample.scrollVisibility !== 'hidden')
    ) {
      throw new Error(`Page-to-scroll exposed an unsettled layer: ${JSON.stringify(flowSwapSamples)}`);
    }
    if ((await page.locator('.reader-flow-pill').innerText()) !== '스크롤') {
      throw new Error('Wheel input did not return automatic mode to continuous scroll');
    }
    const automaticScrollRestore = await page.evaluate(() => {
      const root = document.querySelector('[data-reader-layer="scroll"].is-active');
      if (!(root instanceof HTMLElement)) return { scrollTop: 0, firstIndex: -1 };
      const contentTop = root.getBoundingClientRect().top + (Number.parseFloat(getComputedStyle(root).paddingTop) || 0);
      const first = [...root.querySelectorAll('[data-index]')].find(
        (element) => element.getBoundingClientRect().bottom > contentTop + 1,
      );
      return {
        scrollTop: root.scrollTop,
        scrollbarWidth: root.offsetWidth - root.clientWidth,
        firstIndex: Number(first?.getAttribute('data-index') ?? -1),
        canScroll: root.scrollHeight > root.clientHeight + 1,
        contentTop,
        nearby: [...root.querySelectorAll('[data-index]')]
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              index: Number(element.getAttribute('data-index')),
              id: element.querySelector('[data-paragraph-id]')?.getAttribute('data-paragraph-id'),
              top: Math.round(rect.top),
              bottom: Math.round(rect.bottom),
              text: element.textContent?.trim().slice(0, 24),
            };
          })
          .filter((item) => item.bottom > contentTop - 200 && item.top < contentTop + 500)
          .slice(0, 12),
      };
    });
    const scrollContentFrame = await page.locator('[data-reader-layer="scroll"].is-active').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        top: rect.top + (Number.parseFloat(style.paddingTop) || 0),
        bottom: rect.bottom - (Number.parseFloat(style.paddingBottom) || 0),
      };
    });
    await screenshot(page, 'reader-ui-smoke-page-to-scroll-reverse');
    const reverseMotion = reverseSamples.length > 1 ? reverseSamples[0] - reverseSamples.at(-1) : 0;
    const reversedDirection = reverseSamples.some((value, index) => index > 0 && value > reverseSamples[index - 1] + 2);
    if (
      (paragraphCount > 20 &&
        automaticPageStartIndex > 0 &&
        automaticScrollRestore.canScroll &&
        automaticScrollRestore.scrollTop <= 0) ||
      reverseSamples.some((value) => !Number.isFinite(value)) ||
      (paragraphCount > 20 && (reverseMotion < 20 || reversedDirection)) ||
      automaticScrollRestore.scrollbarWidth !== 0 ||
      (pageContentFrame &&
        (Math.abs(pageContentFrame.top - scrollContentFrame.top) > 2 ||
          Math.abs(pageContentFrame.bottom - scrollContentFrame.bottom) > 2)) ||
      (paragraphCount > 20 &&
        automaticPageStartId.length > 0 &&
        !automaticScrollRestore.nearby.some((item) => item.id === automaticPageStartId))
    ) {
      throw new Error(
        `Immediate reverse wheel transition stalled or jittered: ${JSON.stringify({ automaticPageStartIndex, automaticPageStartId, automaticScrollRestore, reverseSamples, pageContentFrame, scrollContentFrame })}`,
      );
    }

    log('Checking scroll-to-previous-page round trip');
    await page.keyboard.press('PageUp');
    await page.locator('.reader-paginated-root.is-active').waitFor({ state: 'visible', timeout: timeoutMs });
    await page.waitForTimeout(220);
    const reverseTransitionAnchor = {
      index: Number(await page.locator('.reader-screen').getAttribute('data-flow-transition-anchor')),
      offset: Number(await page.locator('.reader-screen').getAttribute('data-flow-transition-offset')),
    };
    await page.waitForTimeout(1_000);
    const previousPageBoundary = await page.locator('.reader-paginated-page.is-current').evaluate((element) => ({
      startIndex: Number(element.getAttribute('data-page-start-index') ?? -1),
      startOffset: Number(element.getAttribute('data-page-start-offset') ?? 0),
      endIndex: Number(element.getAttribute('data-page-end-index') ?? -1),
      endOffset: Number(element.getAttribute('data-page-end-offset') ?? 0),
    }));
    const hasPreviousScrollContent = reverseTransitionAnchor.index > 0 || reverseTransitionAnchor.offset > 0;
    if (
      hasPreviousScrollContent &&
      (previousPageBoundary.endIndex !== reverseTransitionAnchor.index ||
        previousPageBoundary.endOffset !== reverseTransitionAnchor.offset)
    ) {
      throw new Error(
        `Previous page did not end at the scroll anchor: ${JSON.stringify({ reverseTransitionAnchor, previousPageBoundary })}`,
      );
    }
    await page.keyboard.press('PageDown');
    await page.waitForTimeout(220);
    const returnedPageStart = await currentPageStart(page);
    if (
      hasPreviousScrollContent &&
      (returnedPageStart.index !== reverseTransitionAnchor.index ||
        returnedPageStart.offset !== reverseTransitionAnchor.offset)
    ) {
      throw new Error(
        `Previous/next page round trip lost the scroll anchor: ${JSON.stringify({ reverseTransitionAnchor, returnedPageStart })}`,
      );
    }
    await page.locator('.reader-paginated-root.is-active').dispatchEvent('wheel', { deltaY: 90 });
    await page.locator('[data-reader-layer="scroll"].is-active').waitFor({ state: 'visible', timeout: timeoutMs });

    await page.getByRole('button', { name: '읽기 설정 열기' }).click();
    await page.getByRole('tab', { name: '조판', exact: true }).click();
    await page.getByLabel('모드 잠금').getByRole('button', { name: '스크롤', exact: true }).click();
    await page.waitForTimeout(150);
    await page.getByRole('button', { name: '설정 닫기' }).click();
    log('Checking scroll mode lock');
    await page.keyboard.press('PageDown');
    await page.waitForTimeout(300);
    if (await page.locator('.reader-paginated-root.is-active').count()) {
      throw new Error('Scroll lock allowed PageDown to switch into pagination');
    }

    await page.getByRole('button', { name: '읽기 설정 열기' }).click();
    await page.getByRole('tab', { name: '조판', exact: true }).click();
    await page.getByLabel('모드 잠금').getByRole('button', { name: '페이지', exact: true }).click();
    await page.waitForTimeout(150);
    await page.getByRole('button', { name: '설정 닫기' }).click();
    log('Checking page mode lock');
    await page.locator('.reader-paginated-root.is-active').waitFor({ state: 'visible', timeout: timeoutMs });
    await page.locator('.reader-paginated-root.is-active').dispatchEvent('wheel', { deltaY: 220 });
    await page.waitForTimeout(300);
    if (!(await page.locator('.reader-paginated-root.is-active').count())) {
      throw new Error('Page lock allowed wheel input to switch into continuous scroll');
    }

    await page.getByRole('button', { name: '읽기 설정 열기' }).click();
    await page.getByRole('tab', { name: '조판', exact: true }).click();
    await page.getByLabel('모드 잠금').getByRole('button', { name: '자동', exact: true }).click();
    await page.waitForTimeout(150);
    await page.getByRole('button', { name: '설정 닫기' }).click();
    log('Checking automatic vertical swipe transition');
    await page.locator('.reader-paginated-root.is-active').dispatchEvent('wheel', { deltaY: 220 });
    await page.locator('[data-reader-layer="scroll"].is-active').waitFor({ state: 'visible', timeout: timeoutMs });
    await page.waitForTimeout(350);

    log(
      `Automatic mode before PageDown: ${await page.locator('.reader-flow-pill').innerText()} (lock=${await page.locator('.reader-screen').getAttribute('data-reading-mode-lock')})`,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    await page.keyboard.press('PageDown');
    log(
      `Automatic mode after PageDown: ${await page.locator('.reader-flow-pill').innerText()} (paginated=${await page.locator('.reader-paginated-root.is-active').count()})`,
    );
    await page.locator('.reader-paginated-root.is-active').waitFor({ state: 'visible', timeout: timeoutMs });
    await waitForPaginatedPageFit(page, 'mobile automatic paginated reader');
    const mobileAnchorBeforeImmersive = await currentPageStart(page);
    log('Checking mobile immersive layout transition');
    await page.getByRole('button', { name: '리더 추가 메뉴' }).click();
    await page.getByRole('menuitem', { name: '몰입 모드' }).click();
    await page.locator('.reader-screen.immersive').waitFor({ state: 'visible', timeout: timeoutMs });
    await waitForPaginatedPageFit(page, 'mobile immersive paginated reader');
    const mobileAnchorInImmersive = await currentPageStart(page);
    if (
      mobileAnchorInImmersive.index !== mobileAnchorBeforeImmersive.index ||
      mobileAnchorInImmersive.offset !== mobileAnchorBeforeImmersive.offset
    ) {
      throw new Error(
        `Immersive layout transition lost the reading anchor: ${JSON.stringify({ mobileAnchorBeforeImmersive, mobileAnchorInImmersive })}`,
      );
    }
    await page.keyboard.press('Home');
    await page.waitForFunction(
      () => {
        const current = document.querySelector('.reader-paginated-page.is-current');
        return (
          current?.getAttribute('data-page-start-index') === '0' &&
          current?.getAttribute('data-page-start-offset') === '0'
        );
      },
      undefined,
      { timeout: timeoutMs },
    );
    await assertChapterHeading(page, 'immersive chapter first page');
    await assertPaginatedPageFitsViewport(page, 'immersive chapter heading page');
    await page.locator('.reader-paginated-root.is-active').dispatchEvent('pointerdown', {
      pointerId: 7,
      pointerType: 'touch',
      clientX: 195,
      clientY: 422,
    });
    await page.locator('.reader-paginated-root.is-active').dispatchEvent('pointerup', {
      pointerId: 7,
      pointerType: 'touch',
      clientX: 195,
      clientY: 422,
    });
    await page.locator('.reader-screen.immersive').waitFor({ state: 'detached', timeout: timeoutMs });
    await waitForPaginatedPageFit(page, 'mobile standard paginated reader after immersive');
    await page.locator('.reader-paginated-root.is-active').dispatchEvent('pointerdown', {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 195,
      clientY: 620,
    });
    await page.locator('.reader-paginated-root.is-active').dispatchEvent('pointerup', {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 194,
      clientY: 450,
    });
    await page.locator('[data-reader-layer="scroll"].is-active').waitFor({ state: 'visible', timeout: timeoutMs });
    await page.waitForTimeout(700);
    const mobileScroll = await page.locator('[data-reader-layer="scroll"].is-active').evaluate((element) => ({
      scrollTop: element.scrollTop,
      canScroll: element.scrollHeight > element.clientHeight + 1,
    }));
    if (mobileScroll.canScroll && mobileScroll.scrollTop <= 0) {
      throw new Error(
        `Mobile vertical swipe switched flow but did not apply its scroll delta: ${JSON.stringify(mobileScroll)}`,
      );
    }
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.waitForTimeout(300);

    await page.getByRole('button', { name: '부가 기능 열기' }).click();
    await page.locator('.addon-panel').first().waitFor({ state: 'visible', timeout: timeoutMs });
    await page.getByRole('tab', { name: '듣기', exact: true }).click();
    await page.getByRole('heading', { name: 'TTS' }).waitFor({ state: 'visible', timeout: timeoutMs });
    await assertNoHorizontalOverflow(page, 'desktop addon panel');
    await screenshot(page, 'reader-ui-smoke-addon');

    await page.setViewportSize({ width: 820, height: 1180 });
    await page.waitForTimeout(300);
    await assertVisible(page, '.reader-topbar', 'tablet reader topbar');
    await assertReaderDomIsBounded(page);
    await assertNoHorizontalOverflow(page, 'tablet reader with addon');
    await screenshot(page, 'reader-ui-smoke-tablet-addon');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    await assertVisible(page, '.reader-topbar', 'mobile reader topbar');
    await assertReaderDomIsBounded(page);
    await assertNoHorizontalOverflow(page, 'mobile reader with addon');
    await screenshot(page, 'reader-ui-smoke-mobile-addon');

    await page.getByRole('button', { name: '읽기 도구 닫기' }).click();
    await assertNoHorizontalOverflow(page, 'mobile reader');
    await screenshot(page, 'reader-ui-smoke-mobile');

    if (!novelFile) await assertScrollChapterBoundary(browser);

    if (browserErrors.length) {
      throw new Error(`Browser console/page errors detected: ${browserErrors.join(' | ')}`);
    }
  } finally {
    await context.close();
    await browser.close();
  }
}

withServer(runReaderSmoke).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
