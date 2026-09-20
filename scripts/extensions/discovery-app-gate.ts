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
  // A single expanded tab/list keeps a large configuration manageable.
  await tab.getByRole('textbox', { name: '목록 이름', exact: true }).fill('세 번째 목록');
  await editor.getByRole('button', { name: /^소설 목록 0개/ }).click();
  if (await tab.getByRole('button', { name: '목록 추가', exact: true }).isVisible())
    throw new Error('Inactive tab editor remained expanded');
  await editor.getByRole('button', { name: /^만화 목록 3개/ }).click();
  await tab.getByRole('textbox', { name: '목록 이름', exact: true }).waitFor();
  if ((await tab.getByRole('textbox', { name: '목록 이름', exact: true }).inputValue()) !== '세 번째 목록')
    throw new Error('Collapsing a tab lost the draft');
  await editor.getByRole('button', { name: '탭 추가', exact: true }).click();
  const newName = editor.getByRole('textbox', { name: '탭 이름', exact: true });
  await newName.fill('내 추천');
  await editor.getByRole('button', { name: '모두 접기', exact: true }).click();
  if (await editor.getByRole('textbox', { name: '탭 이름', exact: true }).isVisible())
    throw new Error('Collapse all left an editor visible');
  await editor.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByRole('button', { name: 'Synthetic installed novel 상세 보기', exact: true }).first().waitFor();
  await page.getByRole('button', { name: '빠른 이동', exact: true }).click();
  const jump = page.getByRole('dialog', { name: '소스 빠른 이동', exact: true });
  await jump.getByRole('searchbox').fill('앱 검증용');
  await jump.getByRole('button', { name: '앱 검증용 소스', exact: true }).click();
  await page.locator('.source-hub-screen').waitFor();
  await home().click();
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
    await drawer
      .getByRole('navigation', { name: '라이브러리 홈', exact: true })
      .getByRole('button', { name: '홈', exact: true })
      .click();
    await page.locator('.discovery-screen').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: '라이브러리 메뉴', exact: true }).filter({ visible: true }).click();
    await drawer.getByRole('button', { name: /^라이브러리/, expanded: false }).click();
    await drawer
      .getByRole('navigation', { name: '탐색 홈' })
      .getByRole('button', { name: '탐색', exact: true })
      .click();
    const search = page.locator('.discovery-search');
    await search.getByRole('searchbox').fill('Synthetic');
    await search.getByRole('button', { name: '검색', exact: true }).click();
    const reset = search.getByRole('button', { name: '초기화', exact: true });
    const resetBox = await reset.boundingBox();
    if (!resetBox || resetBox.width < 60 || resetBox.height < 44 || resetBox.height > 56)
      throw new Error('Mobile search reset button is wrapped or too small');
    await page.screenshot({ path: resolve(output, `discovery-search-${width}.png`) });
    await reset.click();
    await page.screenshot({ path: resolve(output, `discovery-${width}.png`) });
    await page.getByRole('button', { name: '탐색 편집', exact: true }).click();
    await editor.getByRole('button', { name: /^만화 목록 3개/ }).click();
    await page.screenshot({ path: resolve(output, `discovery-editor-${width}.png`) });
    await editor.getByRole('button', { name: /^만화 목록 3개/ }).click();
    await tab.locator('.discovery-editor-section').first().getByRole('button', { expanded: false }).click();
    await page.screenshot({ path: resolve(output, `discovery-editor-expanded-${width}.png`) });
    const overflow = await editor.evaluate((node) => node.scrollWidth > node.clientWidth + 1);
    if (overflow) throw new Error('Mobile discovery editor overflow');
    await editor.getByRole('button', { name: '취소', exact: true }).click();
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
