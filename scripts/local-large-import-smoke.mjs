import { spawn, spawnSync } from 'node:child_process';
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

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const fixtureMb = positiveInteger(argValue('--mb', process.env.LOCAL_LARGE_IMPORT_MB ?? '20'), 20);
const paragraphsPerChapter = positiveInteger(
  argValue('--paragraphs-per-chapter', process.env.LOCAL_LARGE_IMPORT_PARAGRAPHS_PER_CHAPTER ?? '240'),
  240,
);
const baseUrl = argValue('--url', process.env.LOCAL_LARGE_IMPORT_URL ?? 'http://127.0.0.1:1420');
const explicitChannel = argValue('--channel', process.env.READER_UI_BROWSER_CHANNEL ?? '');
const timeoutMs = positiveInteger(
  argValue('--timeout-ms', process.env.LOCAL_LARGE_IMPORT_TIMEOUT_MS ?? '240000'),
  240000,
);
const headed = hasArg('--headed');
const keepServer = hasArg('--keep-server');
const skipScreenshots = hasArg('--no-screenshots');
const fixturePath = path.resolve(argValue('--output', `fixtures/generated/local-large-${fixtureMb}mb.txt`));
const screenshotDir = path.resolve(
  argValue('--screenshots-dir', process.env.READER_UI_SCREENSHOT_DIR ?? 'screenshots'),
);

function log(message) {
  console.log(message);
}

function run(command, commandArgs) {
  const label = [command, ...commandArgs].join(' ');
  log(`\n$ ${label}`);
  const result = spawnSync(command, commandArgs, {
    cwd: process.cwd(),
    env: process.env,
    shell: process.platform === 'win32',
    stdio: 'inherit',
    encoding: 'utf8',
  });
  if (result.error) throw new Error(`${label} failed to start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}`);
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
    if (keepServer) log('Keeping dev server running.');
    else server.kill();
  }
}

function generateFixture() {
  const chapterBudget = Math.max(12, fixtureMb * 5);
  run('node', [
    'scripts/generate-large-novel-fixture.mjs',
    '--mb',
    String(fixtureMb),
    '--chapters',
    String(chapterBudget),
    '--paragraphChars',
    '320',
    '--paragraphsPerChapter',
    String(paragraphsPerChapter),
    '--output',
    fixturePath,
  ]);
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
    `Could not launch Edge/Chrome for local large import smoke. Set READER_UI_BROWSER_CHANNEL or install a Playwright-compatible browser.\n${errors.join('\n')}`,
  );
}

async function screenshot(page, name) {
  if (skipScreenshots) return;
  await fs.mkdir(screenshotDir, { recursive: true });
  await page.screenshot({ path: path.join(screenshotDir, `${name}.png`), fullPage: true });
}

async function assertNoHorizontalOverflow(page, label) {
  const issues = await page.evaluate(() => {
    const selectors = [
      '.chapters-screen',
      '.sub-header',
      '.chapter-list',
      '.reader-summary',
      '.reader-topbar',
      '.reader-bottombar',
      '.reader-document',
      '.reader-scroll',
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

async function assertReaderDomIsBounded(page, label = 'large import reader screen') {
  const counts = await page.evaluate(() => ({
    paragraphs: document.querySelectorAll('.reader-paragraph').length,
    rows: document.querySelectorAll('.reader-virtual-row').length,
  }));
  if (counts.paragraphs < 1) throw new Error(`${label} rendered no visible paragraphs after large import`);
  if (counts.rows > 55 || counts.paragraphs > 55) {
    throw new Error(`${label} rendered too many virtual rows after large import: ${JSON.stringify(counts)}`);
  }
}

async function assertPageResponsive(page, label) {
  const startedAt = Date.now();
  const width = await page.evaluate(() => document.documentElement.clientWidth);
  const elapsed = Date.now() - startedAt;
  if (!width || elapsed > 3000) throw new Error(`${label} was not responsive enough; evaluate took ${elapsed}ms`);
}

async function waitForVisibleWithResponsiveness(page, locator, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await locator.isVisible().catch(() => false)) return;
    await assertPageResponsive(page, label);
    await delay(1000);
  }
  await locator.waitFor({ state: 'visible', timeout: 1 });
}

async function scrollReaderAndAssertDom(page, fraction, label) {
  await page.locator('.reader-scroll').evaluate((element, targetFraction) => {
    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTo({ top: maxScrollTop * targetFraction, behavior: 'auto' });
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  }, fraction);
  await delay(350);
  await page.locator('.reader-paragraph').first().waitFor({ state: 'visible', timeout: timeoutMs });
  await assertReaderDomIsBounded(page, label);
  await assertPageResponsive(page, label);
}

async function runSmoke() {
  generateFixture();
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
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.locator('input[type="file"]').setInputFiles(fixturePath);
    await page.getByRole('heading', { name: '책 가져오기' }).waitFor({ state: 'visible', timeout: timeoutMs });
    await page.getByText(path.basename(fixturePath)).waitFor({ state: 'visible', timeout: timeoutMs });
    await page.getByRole('button', { name: /가져오기 시작/ }).click();
    await page
      .getByText(/가져오는 중|파일을 읽는 중|책장에 저장하는 중/)
      .first()
      .waitFor({ state: 'visible', timeout: timeoutMs });
    await assertPageResponsive(page, 'local import progress UI');

    const importStartedAt = Date.now();
    await waitForVisibleWithResponsiveness(page, page.locator('.chapters-screen'), 'local import active UI');
    const importSeconds = ((Date.now() - importStartedAt) / 1000).toFixed(1);
    log(`Large local import completed in ${importSeconds}s after progress started.`);
    await assertNoHorizontalOverflow(page, 'large import chapter screen');
    await screenshot(page, `local-large-import-${fixtureMb}mb-chapters`);

    const chapterCountText = await page.locator('.chapter-tools span').first().textContent({ timeout: timeoutMs });
    if (!chapterCountText || !/\d/.test(chapterCountText)) {
      throw new Error('Chapter list did not show imported chapter counts');
    }

    await page.getByRole('button', { name: '이어 읽기' }).first().click();
    await page.getByPlaceholder('본문 검색').waitFor({ state: 'visible', timeout: timeoutMs });
    await page.locator('.reader-paragraph').first().waitFor({ state: 'visible', timeout: timeoutMs });
    await assertReaderDomIsBounded(page, 'large import reader top');
    await scrollReaderAndAssertDom(page, 0.5, 'large import reader middle');
    await scrollReaderAndAssertDom(page, 1, 'large import reader end');
    await assertNoHorizontalOverflow(page, 'large import reader screen');

    await page.getByPlaceholder('본문 검색').fill('marker-1-1');
    await page
      .getByText(/현재 화 검색|결과/)
      .first()
      .waitFor({ state: 'visible', timeout: timeoutMs });
    await assertNoHorizontalOverflow(page, 'large import reader search');
    await screenshot(page, `local-large-import-${fixtureMb}mb-reader`);

    if (browserErrors.length) {
      throw new Error(`Browser console/page errors detected: ${browserErrors.join(' | ')}`);
    }
  } finally {
    await context.close();
    await browser.close();
  }
}

withServer(runSmoke).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
