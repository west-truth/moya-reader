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
  const counts = await page.evaluate(() => ({
    paragraphs: document.querySelectorAll('.reader-paragraph').length,
    rows: document.querySelectorAll('.reader-virtual-row').length,
  }));
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
    await openSampleReader(page);
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

    await page.getByRole('button', { name: '읽기 설정 열기' }).click();
    await page.getByRole('heading', { name: '읽기 설정' }).waitFor({ state: 'visible', timeout: timeoutMs });
    await assertNoHorizontalOverflow(page, 'desktop settings panel');
    await screenshot(page, 'reader-ui-smoke-settings');
    await page.getByRole('button', { name: '설정 닫기' }).click();

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
