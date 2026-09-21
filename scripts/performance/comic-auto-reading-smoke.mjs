import assert from 'node:assert/strict';

// Run inside the existing comic fixture/browser, never against user books.
export async function verifyComicAutoReading(newPage) {
  const openControls = async (page) => {
    const menu = page.getByRole('button', { name: '문서 메뉴', exact: true });
    if (await menu.isVisible()) await menu.click();
    await page.getByRole('button', { name: '자동 읽기', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '자동 읽기' });
    await dialog.waitFor();
    const bounds = await dialog.evaluate((element) => ({
      width: element.clientWidth,
      content: element.scrollWidth,
      top: element.getBoundingClientRect().top,
      bottom: element.getBoundingClientRect().bottom,
      height: innerHeight,
    }));
    assert.ok(
      bounds.content <= bounds.width + 1 && bounds.top >= 0 && bounds.bottom <= bounds.height,
      JSON.stringify(bounds),
    );
  };
  const start = async (page, turn = false, next = false) => {
    await openControls(page);
    const input = page.getByRole('spinbutton', { name: turn ? '넘김 간격 직접 입력' : '읽기 속도 직접 입력' });
    await input.fill(turn ? '3' : '12');
    await input.press('Tab');
    if (next) await page.getByRole('checkbox', { name: '회차 끝에서 다음 회차로 이동' }).check();
    await page.getByRole('button', { name: '시작', exact: true }).click();
    await page.getByRole('button', { name: '자동 읽기 정지' }).waitFor();
  };
  const current = (page) => page.locator('.fixed-doc-pages article.is-current').getAttribute('data-page-index');
  const page = await newPage();
  await page.setViewportSize({ width: 393, height: 844 });
  await page.goto('http://reader.test/comic?auto-comic');
  await page.waitForFunction(() => document.querySelector('[data-page-index="2"] img')?.naturalWidth > 0);
  await page.evaluate(() => {
    const v = document.querySelector('.fixed-doc-viewport');
    v.scrollTop +=
      document.querySelector('[data-page-index="2"]').getBoundingClientRect().top - v.getBoundingClientRect().top - 350;
  });
  const seam = await page.locator('[data-page-index="2"] img').boundingBox();
  const pixels = await page.screenshot({ clip: { x: seam.x + 20, y: Math.floor(seam.y) - 3, width: 1, height: 6 } });
  const colors = await page.evaluate(async (base64) => {
    const image = new Image();
    image.src = 'data:image/png;base64,' + base64;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    return [...ctx.getImageData(0, 0, image.width, image.height).data];
  }, pixels.toString('base64'));
  for (let i = 0; i < colors.length; i += 4)
    assert.deepEqual(colors.slice(i, i + 4), [0, 128, 128, 255], 'No dark seam at fractional image boundary');
  await page.evaluate(() => {
    document.querySelector('.fixed-doc-viewport').scrollTop = 0;
  });
  await start(page);
  const initial = await page.locator('.fixed-doc-viewport').evaluate((e) => e.scrollTop);
  await page.waitForFunction((top) => document.querySelector('.fixed-doc-viewport').scrollTop > top + 25, initial);
  await page.getByRole('button', { name: '자동 읽기 정지' }).click();
  const stopped = await page.locator('.fixed-doc-viewport').evaluate((e) => e.scrollTop);
  await page.waitForTimeout(250);
  assert.equal(await page.locator('.fixed-doc-viewport').evaluate((e) => e.scrollTop), stopped);
  await page.close();

  for (const query of ['paged-comic', 'paged-comic&spread&rtl']) {
    const paged = await newPage();
    await paged.setViewportSize({ width: query.includes('spread') ? 1366 : 390, height: 844 });
    await paged.goto('http://reader.test/comic?auto-comic&' + query);
    await paged.waitForFunction(() => document.querySelector('.is-current img')?.naturalWidth > 0);
    await start(paged, true);
    await paged.waitForFunction(
      () => document.querySelector('.fixed-doc-pages article.is-current')?.dataset.pageIndex === '1',
      undefined,
      { timeout: 8000 },
    );
    if (query.includes('spread')) assert.equal(await paged.locator('.fixed-doc-pages article').count(), 2);
    await paged.getByRole('button', { name: '자동 읽기 정지' }).waitFor({ state: 'hidden', timeout: 12000 });
    assert.equal(await current(paged), query.includes('spread') ? '1' : '2', 'Stop at episode end by default');
    await start(paged, true, true);
    await paged.waitForFunction(
      () => Number(document.querySelector('.fixed-doc-pages article.is-current')?.dataset.pageIndex) >= 3,
      undefined,
      { timeout: 8000 },
    );
    await paged.mouse.click(8, 220);
    await paged.getByRole('button', { name: '자동 읽기 정지' }).waitFor({ state: 'hidden' });
    await paged.close();
  }

  const slow = await newPage();
  await slow.goto('http://reader.test/comic?auto-comic&paged-comic&slow-next');
  await slow.waitForFunction(() => document.querySelector('.is-current img')?.naturalWidth > 0);
  await start(slow, true);
  await slow.waitForTimeout(3500);
  assert.equal(await current(slow), '0', 'Unready next page must not consume the interval');
  await slow.waitForFunction(
    () => document.querySelector('.fixed-doc-pages article.is-current')?.dataset.pageIndex === '1',
    undefined,
    { timeout: 8000 },
  );
  await slow.getByRole('button', { name: '자동 읽기 정지' }).click();
  await slow.close();
  const failed = await newPage();
  await failed.goto('http://reader.test/comic?auto-comic&paged-comic&failed-next');
  await failed.waitForFunction(() => document.querySelector('.is-current img')?.naturalWidth > 0);
  await openControls(failed);
  await failed.getByRole('button', { name: '시작', exact: true }).click();
  await failed.waitForTimeout(300);
  assert.equal(await current(failed), '0');
  assert.equal(
    await failed.getByRole('button', { name: '자동 읽기 정지' }).count(),
    0,
    'Image failure stops automatic reading',
  );
  await failed.close();
}
