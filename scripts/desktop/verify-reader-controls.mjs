import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

/** Shared real-UI proof for the browser and the native WebView. Starts inside a text book. */
export async function verifyReaderControls(page, { font = false } = {}) {
  page.setDefaultTimeout(30_000);
  console.log('Checking reader controls and selection');
  const root = page.locator('.reader-viewport-layer.is-active');
  const center = async () => {
    const rect = await root.boundingBox();
    assert(rect, 'Active reader viewport is missing');
    await root.click({ position: { x: rect.width / 2, y: rect.height / 2 } });
  };
  if (await page.locator('.reader-screen.immersive').count()) await center();
  await page.waitForTimeout(3000);
  assert.equal(await page.locator('.reader-screen.chrome-visible').count(), 1, 'Reader controls auto-hid');
  assert.equal(await page.getByRole('button', { name: '선택 문장 하이라이트', exact: true }).isEnabled(), false);
  await page.getByRole('button', { name: '자동 스크롤 설정', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '자동 읽기', exact: true });
  await dialog.waitFor();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await center();
  await page.locator('.reader-screen.immersive').waitFor();
  const select = () =>
    root.evaluate((element) => {
      const nodes = [...element.querySelectorAll('[data-reader-text]')]
        .filter((node) => node.textContent.trim().length > 3)
        .slice(0, 2);
      if (nodes.length !== 2) throw new Error('Selection fixture needs two visible paragraphs');
      const first = document.createTreeWalker(nodes[0], NodeFilter.SHOW_TEXT).nextNode();
      const walker = document.createTreeWalker(nodes[1], NodeFilter.SHOW_TEXT);
      let last;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) last = node;
      window.getSelection().setBaseAndExtent(first, 1, last, last.textContent.length - 1);
    });
  await select();
  await page.getByRole('button', { name: '노랑 하이라이트', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('.reader-viewport-layer.is-active .reader-inline-highlight').length >= 2,
  );
  await page.locator('.selection-action-bar').waitFor({ state: 'hidden' });
  await select();
  const remove = page.getByRole('button', { name: '선택 범위의 하이라이트 삭제', exact: true });
  await remove.waitFor();
  const bar = await page.locator('.selection-action-bar').boundingBox();
  const width = await page.evaluate(() => window.innerWidth);
  assert(bar && bar.x >= 0 && bar.x + bar.width <= width, 'Selection toolbar leaves viewport');
  await remove.click();
  await page.waitForFunction(
    () => !document.querySelector('.reader-viewport-layer.is-active .reader-inline-highlight'),
  );
  await page.locator('.selection-action-bar').waitFor({ state: 'hidden' });
  console.log('Reader selection and controls passed');
  if (font) {
    console.log('Checking reader font installation');
    await center();
    await page.getByRole('button', { name: '리더 추가 메뉴', exact: true }).click();
    await page.getByRole('menuitem', { name: '전체 읽기 설정', exact: true }).click();
    await page.getByRole('tab', { name: /리더 보기/ }).click();
    const require = createRequire(import.meta.url);
    await page
      .locator('.reader-user-fonts input[type="file"]')
      .setInputFiles(require.resolve('pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf'));
    await page.locator('.reader-user-font-row.active').waitFor();
    await page.getByRole('button', { name: '설정 닫기', exact: true }).click();
    await page.waitForFunction(() =>
      [...document.fonts].some((face) => face.family.includes('NovelDesk User ') && face.status === 'loaded'),
    );
    await page.getByRole('button', { name: '리더 추가 메뉴', exact: true }).click();
    await page.getByRole('menuitem', { name: '전체 읽기 설정', exact: true }).click();
    await page.getByRole('tab', { name: /리더 보기/ }).click();
    await page.locator('.reader-user-font-row.active').waitFor();
    page.once('dialog', (confirmation) => confirmation.accept());
    await page.locator('.reader-user-font-row.active').getByRole('button', { name: /삭제$/ }).click();
    await page.locator('.reader-user-font-row').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '설정 닫기', exact: true }).click();
  }
  return {
    selectionSavedAndRemoved: true,
    chromeLatched: true,
    autoScrollEntry: true,
    userFontInstalledAndRemoved: font,
  };
}
