import type { Page } from 'playwright-core';
import { resolve } from 'node:path';

/** Uses the real App/registry/controller against the gate's isolated installed package. */
export async function runDiscoveryAppGate(page: Page, output: string) {
  const home = () =>
    page.getByRole('navigation', { name: '탐색 홈' }).getByRole('button', { name: '탐색', exact: true });
  await home().click();
  await page.getByRole('button', { name: '소스와 목록 선택', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '탐색 편집', exact: true });
  const tab = editor.getByRole('region', { name: '만화 탭 편집', exact: true });
  await tab.getByRole('button', { name: '목록 추가', exact: true }).click();
  await tab.getByRole('combobox', { name: '목록 소스', exact: true }).selectOption({ label: '앱 검증용 소스' });
  await tab.getByRole('button', { name: '목록 추가', exact: true }).click();
  await tab.getByRole('button', { name: '목록 추가', exact: true }).click();
  await editor.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByRole('button', { name: 'Synthetic installed novel 상세 보기', exact: true }).first().waitFor();
  await page.screenshot({ path: resolve(output, 'discovery-desktop.png') });
  await page.locator('.discovery-body').evaluate((node) => {
    node.scrollTop = 320;
    node.dispatchEvent(new Event('wheel'));
    node.dispatchEvent(new Event('scroll'));
  });
  await page.getByRole('button', { name: 'Synthetic installed novel 상세 보기', exact: true }).nth(1).click();
  await page.getByText('First chapter', { exact: true }).first().waitFor();
  await page.goBack();
  await page.getByRole('button', { name: 'Synthetic installed novel 상세 보기', exact: true }).first().waitFor();
  await page.waitForFunction(() => (document.querySelector('.discovery-body')?.scrollTop ?? 0) > 200);
  await page.getByLabel('탐색 작품 검색').fill('No matching fixture');
  await page.locator('.discovery-search').getByRole('button', { name: '검색', exact: true }).click();
  await page.getByText('조건에 맞는 작품이 없습니다.', { exact: true }).waitFor();
  await page.locator('.discovery-search').getByRole('button', { name: '초기화', exact: true }).click();
  await page.getByRole('button', { name: 'Synthetic installed novel 상세 보기', exact: true }).first().waitFor();
  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.getByRole('button', { name: '라이브러리 메뉴', exact: true }).filter({ visible: true }).click();
    const drawer = page.getByRole('dialog');
    const library = drawer.getByRole('button', { name: /^라이브러리/, expanded: true });
    await library.click();
    if (await drawer.getByRole('navigation', { name: '작품 상태' }).isVisible())
      throw new Error('Collapsed library still visible');
    await drawer.getByRole('button', { name: /^라이브러리/, expanded: false }).click();
    await drawer
      .getByRole('navigation', { name: '탐색 홈' })
      .getByRole('button', { name: '탐색', exact: true })
      .click();
    await page.screenshot({ path: resolve(output, `discovery-${width}.png`) });
    const heading = await page.locator('.discovery-topbar').boundingBox();
    if (!heading || heading.height > 80) throw new Error('Mobile discovery heading consumed excessive vertical space');
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1))
      throw new Error('Discovery horizontal page overflow');
  }
  await page.reload();
  await page.setViewportSize({ width: 1366, height: 1000 });
  await home().click();
  await page.getByRole('button', { name: 'Synthetic installed novel 상세 보기', exact: true }).first().waitFor();
  console.log('discovery app gate: edit, persistence, detail/back, search, mobile collapse and layout passed');
}
