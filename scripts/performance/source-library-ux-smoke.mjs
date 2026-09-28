import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

// Exercise the real app/controller/storage with a deterministic, offline source.
const sourceId = 'moya.dev.external-fixture.catalog';
const fixture = `
import {MOYA_EXTENSION_API_VERSION, MOYA_EXTENSION_MANIFEST_VERSION, MOYA_EXTERNAL_SOURCE_SCHEMA_VERSION} from '@noveldesk/extension-contracts';
const id = '${sourceId}';
export const mockExternalSourceTrustedExtension = {
 manifest: {manifestVersion:MOYA_EXTENSION_MANIFEST_VERSION,id:'moya.dev.external-fixture',name:'검증 소스',version:'1.0.0',engine:{moyaApi:MOYA_EXTENSION_API_VERSION},permissions:['external.source.list','external.source.download'],contributes:{externalSources:[{id,schemaVersion:MOYA_EXTERNAL_SOURCE_SCHEMA_VERSION,title:'검증 소스',kind:'catalog',capabilities:['browse','search','work-import','subscriptions'],runtimes:['web-direct']}]}},
 activate(context) { return context.externalSources.register(id, {
  status:()=>({state:new URLSearchParams(location.search).has('sourceOffline')?'disconnected':'connected',accountConnectionId:'fixture-account',label:'검증 연결'}),
  connect:async()=>{}, disconnect:async()=>{},
  list:async(_host,input,signal)=>{
    if(input.parentRef) await new Promise(resolve=>setTimeout(resolve,700));
    signal.throwIfAborted();
    const works=Array.from({length:12},(_,i)=>({key:{connectorId:id,accountConnectionId:'fixture-account',remoteId:'work-'+i},kind:'work',title:'검증 작품 '+i,navigationRef:'work-'+i,importability:'unsupported'}));
    return input.parentRef ? {items:[],detail:{title:'검증 작품 '+input.parentRef.split('-')[1]}} : {items:works};
  }, download:async()=>{throw Error('Downloads must not run in this smoke');}
 });}
};`;
process.env.VITE_ENABLE_EXTERNAL_SOURCE_SMOKE_FIXTURE = 'true';
let delayedProjection = false;
const server = await createServer({
  server: { host: '127.0.0.1', port: 0 },
  plugins: [
    {
      name: 'source-library-smoke-fixture',
      enforce: 'pre',
      load(id) {
        if (id.endsWith('/src/extensions/examples/mock-external-source-extension.ts')) return fixture;
      },
      transform(code, id) {
        if (!id.endsWith('/src/features/external-sources/useExternalSourceController.ts')) return;
        const signature = 'async function loadSourceLibrary(options: UseExternalSourceControllerOptions) {';
        assert(code.includes(signature));
        delayedProjection = true;
        return code.replace(
          signature,
          signature +
            `
  const smokeQuery = new URLSearchParams(location.search);
  if (smokeQuery.has('sourceFailure')) throw new Error('Simulated source storage failure');
  await new Promise(resolve => setTimeout(resolve, smokeQuery.has('sourceSlow') ? 12000 : 1200));`,
        );
      },
    },
  ],
});
await server.listen();
const browser = await chromium.launch({ headless: true });
await mkdir('.tmp/source-library-review', { recursive: true });
try {
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => dialog.accept());
    page.setDefaultTimeout(15000);
    await page.goto(server.resolvedUrls.local[0]);
    await page.getByRole('button', { name: '샘플 추가', exact: true }).click();
    await page.locator('.chapters-screen').waitFor();
    await page.evaluate(async (connectorId) => {
      const { ExternalSourceLocalStateStore, externalSourceSubscriptionId } =
        await import('/src/external-sources/local-state.ts');
      const { releasePreferenceId } = await import('/src/external-sources/source-user-state.ts');
      const state = new ExternalSourceLocalStateStore();
      const now = new Date().toISOString();
      for (let i = 0; i < 12; i++) {
        const remoteId = 'work-' + i;
        await state.saveSubscription({
          id: externalSourceSubscriptionId(connectorId, 'fixture-account', remoteId),
          connectorId,
          accountConnectionId: 'fixture-account',
          collectionRemoteId: remoteId,
          navigationRef: remoteId,
          title: '검증 작품 ' + i,
          knownReleaseIds: ['work-' + i + '-chapter-7'],
          newReleaseIds: [],
          availableReleaseCount: 10,
          releaseBaselineComplete: true,
          lastCheckedAt: now,
          createdAt: now,
          updatedAt: now,
          schemaVersion: 1,
        });
      }
      const source = { connectorId, accountConnectionId: 'fixture-account', remoteId: 'work-0-chapter-7' };
      await state.saveReleasePreferences([
        {
          id: releasePreferenceId(source),
          kind: 'releasePreference',
          source,
          collectionRemoteId: 'work-0',
          read: true,
          lastReadAt: now,
          updatedAt: now,
        },
      ]);
    }, sourceId);
    await page.addInitScript(() => {
      globalThis.libraryCardSnapshots = [];
      new MutationObserver(() => {
        const cards = document.querySelectorAll('.book-card');
        if (cards.length)
          globalThis.libraryCardSnapshots.push({
            total: cards.length,
            remote: document.querySelectorAll('.external-work-card').length,
            sourceSkeleton: Boolean(document.querySelector('.library-source-loading .skeleton')),
          });
      }).observe(document, { subtree: true, childList: true });
    });
    await page.reload();
    await page.locator('.external-work-card').first().waitFor();
    const firstCards = await page.evaluate(() => globalThis.libraryCardSnapshots[0]);
    assert(firstCards.total === 1 && firstCards.remote === 0 && firstCards.sourceSkeleton, JSON.stringify(firstCards));
    const before = await page.evaluate(
      async () =>
        await new (
          await import('/src/external-sources/local-state.ts')
        ).ExternalSourceLocalStateStore().listReleasePreferences(),
    );
    await page.getByRole('button', { name: '검증 작품 0 원격 회차 열기', exact: true }).click();
    await page.locator('#source-work-title').filter({ hasText: '검증 작품 0' }).waitFor();
    await page.locator('.source-hub-screen[aria-busy="false"]').waitFor();
    await page.getByText('작품 관리 및 파일 정보', { exact: true }).click();
    await page.getByRole('button', { name: '휴지통으로 이동', exact: true }).click();
    await page.locator('.source-hub-screen').waitFor({ state: 'hidden' });
    await page.reload();
    await page.locator('.external-work-card').first().waitFor();
    assert.equal(await page.getByRole('button', { name: '검증 작품 0 원격 회차 열기', exact: true }).count(), 0);
    if (width < 700) await page.getByRole('button', { name: '라이브러리 메뉴', exact: true }).click();
    await page
      .locator(width < 700 ? '.library-mobile-drawer' : '.library-sidebar')
      .getByRole('button', { name: /^휴지통/ })
      .click();
    await page.getByRole('button', { name: '검증 작품 0 복원', exact: true }).waitFor();
    await page.screenshot({ path: `.tmp/source-library-review/trash-${width}.png` });
    await page.getByRole('button', { name: '검증 작품 0 복원', exact: true }).click();
    await page.getByRole('button', { name: '검증 작품 0 복원', exact: true }).waitFor({ state: 'hidden' });
    const after = await page.evaluate(
      async () =>
        await new (
          await import('/src/external-sources/local-state.ts')
        ).ExternalSourceLocalStateStore().listReleasePreferences(),
    );
    assert.deepEqual(after, before);
    if (width < 700) await page.getByRole('button', { name: '라이브러리 메뉴', exact: true }).click();
    await page
      .locator(width < 700 ? '.library-mobile-drawer' : '.library-sidebar')
      .getByRole('button', { name: /^검증 소스/ })
      .click();
    const disclosure = page.locator('.source-hub-subscriptions');
    await disclosure.waitFor();
    assert.equal(await disclosure.evaluate((node) => node.open), false);
    assert((await disclosure.boundingBox()).height <= 60);
    await disclosure.locator('summary').click();
    assert.equal(await disclosure.locator('.source-hub-subscription-card').count(), 12);
    await disclosure.locator('summary').click();
    await page.screenshot({ path: `.tmp/source-library-review/collapsed-${width}.png` });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    // Library removal must not depend on the source being connected or a detail request succeeding.
    await page.goto(server.resolvedUrls.local[0] + '?sourceOffline');
    const more = page.getByRole('button', { name: '검증 작품 1 더보기', exact: true });
    for (const view of ['compact', 'list', 'text', 'grid']) {
      await page.getByRole('combobox', { name: '라이브러리 보기 방식' }).selectOption(view);
      await more.click();
      const menu = page.getByRole('menu', { name: '검증 작품 1 작품 관리' });
      await menu.waitFor();
      const box = await menu.boundingBox();
      assert(box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= 900);
      await page.keyboard.press('Escape');
      assert(await more.evaluate((node) => node === document.activeElement));
    }
    await more.click();
    await page.getByRole('menuitem', { name: '휴지통으로 이동', exact: true }).click();
    await more.waitFor({ state: 'hidden' });
    const deletedAt = await page.evaluate(
      async () =>
        (
          await new (
            await import('/src/external-sources/local-state.ts')
          ).ExternalSourceLocalStateStore().listSubscriptions()
        ).find((work) => work.title === '검증 작품 1')?.deletedAt,
    );
    assert(deletedAt);
    // The same selection toolbar must handle remote, local and mixed trash/restore.
    await page.getByRole('button', { name: '선택', exact: true }).click();
    for (const view of ['compact', 'list', 'text', 'grid']) {
      await page.getByRole('combobox', { name: '라이브러리 보기 방식' }).selectOption(view);
      const choose = page.getByRole('button', { name: '검증 작품 0 선택', exact: true });
      await choose.click();
      assert.equal(
        await page.getByRole('button', { name: '검증 작품 0 선택 해제', exact: true }).getAttribute('aria-pressed'),
        'true',
      );
      assert.equal(await page.getByRole('button', { name: '선택한 책 즐겨찾기 설정' }).isEnabled(), false);
      const selectedRow = page.locator('.external-work-card.is-selected, .external-work-list-row.is-selected');
      const rowBox = await selectedRow.boundingBox();
      const markBox = await selectedRow.locator('.book-selection-mark').boundingBox();
      assert(markBox.y >= rowBox.y && markBox.y + markBox.height <= rowBox.y + rowBox.height);
      if (view === 'text') await page.screenshot({ path: `.tmp/source-library-review/selection-text-${width}.png` });
      await page.getByRole('button', { name: '검증 작품 0 선택 해제', exact: true }).click();
    }
    await page.getByRole('button', { name: '모두 선택', exact: true }).click();
    assert.equal(await page.locator('.book-card-open[aria-pressed="true"]').count(), 12);
    await page.getByRole('button', { name: '선택한 책 휴지통으로 이동' }).click();
    await page.locator('.library-batch-bar').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.book-card').count(), 0);
    if (width < 700) await page.getByRole('button', { name: '라이브러리 메뉴', exact: true }).click();
    await page
      .locator(width < 700 ? '.library-mobile-drawer' : '.library-sidebar')
      .getByRole('button', { name: /^휴지통/ })
      .click();
    assert.equal(await page.locator('.book-card').count(), 13);
    await page.getByRole('button', { name: '선택', exact: true }).click();
    // Restore a stream-only selection first, then restore the remaining mixed selection.
    await page.getByRole('button', { name: '검증 작품 0 선택', exact: true }).click();
    await page.getByRole('button', { name: '선택한 책 복원' }).click();
    await page.locator('.library-batch-bar').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.book-card').count(), 12);
    await page.getByRole('button', { name: '선택', exact: true }).click();
    await page.getByRole('button', { name: '모두 선택', exact: true }).click();
    await page.getByRole('button', { name: '선택한 책 복원' }).click();
    await page.locator('.library-batch-bar').waitFor({ state: 'hidden' });
    const restored = await page.evaluate(async () => {
      const { ExternalSourceLocalStateStore } = await import('/src/external-sources/local-state.ts');
      const state = new ExternalSourceLocalStateStore();
      return { works: await state.listSubscriptions(), history: await state.listReleasePreferences() };
    });
    assert.equal(restored.works.filter((work) => work.deletedAt).length, 0);
    assert.deepEqual(restored.history, before);
    await page.goto(server.resolvedUrls.local[0] + '?sourceFailure');
    await page.getByText('소스 작품을 불러오지 못했습니다', { exact: true }).waitFor();
    assert.equal(await page.locator('.book-card:not(.external-work-card)').count(), 1);
    await page.evaluate(() => history.replaceState(null, '', location.pathname));
    await page.locator('.library-source-loading').getByRole('button', { name: '다시 시도' }).click();
    await page.locator('.external-work-card').first().waitFor();
    assert.equal(await page.locator('.external-work-card').count(), 12);
    if (width === 390) {
      await page.goto(server.resolvedUrls.local[0] + '?sourceSlow');
      await page.getByText('소스 작품을 불러오는 데 시간이 걸립니다', { exact: true }).waitFor();
      assert.equal(await page.locator('.book-card:not(.external-work-card)').count(), 1);
      await page.screenshot({ path: '.tmp/source-library-review/slow-source-390.png' });
      await page.evaluate(() => history.replaceState(null, '', location.pathname));
      await page.locator('.library-source-loading').getByRole('button', { name: '다시 시도' }).click();
      await page.locator('.external-work-card').first().waitFor();
    }
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        width,
        firstCards,
        collapsed: true,
        trashRestorePreservesHistory: true,
        offlineRemoval: true,
        menuViews: 4,
        batchTrashRestore: true,
        independentLoadingAndRetry: true,
      }),
    );
    await context.close();
  }
  assert(delayedProjection);
} catch (error) {
  for (const context of browser.contexts())
    for (const page of context.pages()) {
      await page.screenshot({ path: '.tmp/source-library-review/failure.png' });
      console.error((await page.locator('body').innerText()).slice(-4000));
    }
  throw error;
} finally {
  await browser.close();
  await server.close();
}
