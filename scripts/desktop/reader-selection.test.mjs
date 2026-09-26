import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

test('reader selection preserves per-paragraph ranges across lines and backward drags', async () => {
  const server = await createServer({
    root: fileURLToPath(new URL('../../', import.meta.url)),
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    plugins: [
      {
        name: 'reader-selection-proof',
        configureServer(vite) {
          vite.middlewares.use((req, res, next) => {
            if (req.url !== '/__selection') return next();
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(`<!doctype html><style>p{width:90px;line-height:24px}</style><main id="reader">
          <div data-paragraph-id="p1"><div class="segment-meta">not body</div><p data-reader-text>첫 번째 <b>선택할 문장</b> 끝</p></div>
          <div data-paragraph-id="p2"><p data-reader-text>두 번째 문단입니다</p></div>
          <div data-paragraph-id="p3"><p data-reader-text>선택하지 않은 문단</p></div>
        </main><input id="other">`);
          });
        },
      },
    ],
  });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__selection`);
    const result = await page.evaluate(async () => {
      const { readReaderSelection } = await import('/src/features/reader/reader-selection.ts');
      const { AnnotationPersistence } = await import('/src/features/annotations/annotation-persistence.ts');
      const root = document.querySelector('#reader');
      const first = root.querySelector('b').firstChild;
      const second = root.querySelector('[data-paragraph-id="p2"] p').firstChild;
      const selection = window.getSelection();
      selection.removeAllRanges();
      const empty = readReaderSelection(root);
      selection.setBaseAndExtent(first, 0, second, 5);
      const forward = readReaderSelection(root);
      selection.setBaseAndExtent(second, 5, first, 0);
      const backward = readReaderSelection(root);
      const paragraphs = [...root.querySelectorAll('[data-reader-text]')].map((node) => ({
        id: node.closest('[data-paragraph-id]').dataset.paragraphId,
        text: node.textContent,
        novelId: 'book',
        chapterId: 'chapter',
      }));
      const rows = new Map();
      const repository = {
        getParagraph: async (id) => paragraphs.find((p) => p.id === id),
        listHighlights: async () => [...rows.values()],
        saveHighlight: async (row) => rows.set(row.id, row),
        deleteHighlight: async (id) => rows.delete(id),
      };
      const persistence = new AnnotationPersistence(repository);
      const location = { progress: 0, scrollTop: 0, paragraphIndex: 0, paragraph: paragraphs[0] };
      const context = {
        novel: { id: 'book' },
        chapter: { id: 'chapter' },
        reader: {
          getLocation: () => location,
          getCachedParagraphById: (id) => paragraphs.find((p) => p.id === id),
          getSelection: () => undefined,
        },
        readerProgress: 0,
        highlights: [],
      };
      await persistence.setHighlight(context, 'yellow');
      const emptyCount = rows.size;
      await persistence.setHighlight(context, 'yellow', location, backward);
      const saved = [...rows.values()].map((row) => ({ paragraphId: row.paragraphId, text: row.quote }));
      await persistence.setHighlight({ ...context, highlights: [...rows.values()] }, 'remove', location, forward);
      return { empty, emptyCount, forward, backward, saved, remaining: rows.size };
    });
    assert.equal(result.empty, undefined);
    assert.equal(result.emptyCount, 0);
    assert.deepEqual(result.forward, result.backward);
    assert.deepEqual(result.saved, [
      { paragraphId: 'p1', text: '선택할 문장 끝' },
      { paragraphId: 'p2', text: '두 번째 ' },
    ]);
    assert.equal(result.remaining, 0);
    // Selecting outside the reader must not reuse its first paragraph.
    await page.locator('#other').fill('outside');
    await page.locator('#other').selectText();
    assert.equal(
      await page.evaluate(async () => {
        const { readReaderSelection } = await import('/src/features/reader/reader-selection.ts');
        return readReaderSelection(document.querySelector('#reader'));
      }),
      undefined,
    );
  } finally {
    await browser?.close();
    await server.close();
  }
});
