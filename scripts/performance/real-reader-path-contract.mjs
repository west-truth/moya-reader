import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const CHECKS = [
  {
    id: 'browser-import-worker',
    file: 'src/services/import/browser-import-service.ts',
    patterns: ["new Worker(new URL('./import-worker.ts'", "type: 'start'", "type: 'cancel'"],
  },
  {
    id: 'worker-chunked-read-and-storage',
    file: 'src/services/import/import-worker.ts',
    patterns: ['readFileAsArrayBufferInChunks', 'runBrowserImportPipeline', "type: 'complete'"],
  },
  {
    id: 'cooperative-import-pipeline',
    file: 'src/services/import/browser-import-pipeline.ts',
    patterns: [
      'parseDecodedNovelTextForImportCooperatively',
      'saveParsedNovelImport',
      'BROWSER_IMPORT_WRITE_BATCH_PAGES = 16',
      'shouldCancel: input.shouldCancel',
    ],
  },
  {
    id: 'local-runtime',
    file: 'src/repositories/reader-runtime.ts',
    patterns: ['new IndexedDbReaderRepository()', 'new BrowserImportService()'],
  },
  {
    id: 'active-app-import-route',
    file: 'src/App.tsx',
    patterns: ['const importFeature = useImportController({', '<ImportFeatureHost', 'controller={importFeature}'],
  },
  {
    id: 'active-import-host',
    file: 'src/features/import/ImportFeatureHost.tsx',
    patterns: ["lazy(() => import('./ImportDialog'))", '<ImportDialog controller={controller}'],
  },
  {
    id: 'active-import-controller',
    file: 'src/features/import/useImportController.ts',
    patterns: [
      'runImportBatch(',
      'importService: optionsRef.current.importService',
      'cancellationRef.current.cancel()',
      'onImportCommitted(outcome.lastImportedNovel ?? openExisting)',
    ],
  },
  {
    id: 'active-import-batch-runner',
    file: 'src/features/import/import-controller.ts',
    patterns: ['input.importService.importFile(', 'cancellation.bind(controller)', 'await controller.promise'],
  },
  {
    id: 'active-import-dialog',
    file: 'src/features/import/ImportDialog.tsx',
    patterns: [
      'controller.selectFiles(files)',
      'controller.startPendingImport()',
      '<ImportProgressPanel controller={controller}',
    ],
  },
  {
    id: 'active-app-reader-route',
    file: 'src/App.tsx',
    patterns: ["lazy(() => import('./features/reader/ReaderScreen'))", '<ReaderScreen'],
  },
  {
    id: 'active-reader-screen',
    file: 'src/features/reader/ReaderScreen.tsx',
    patterns: ['useReaderSearch({', '<ReaderViewport'],
  },
  {
    id: 'active-reader-virtualization',
    file: 'src/features/reader/ReaderViewport.tsx',
    patterns: ['useVirtualizer({', 'reader-virtual-row', 'reader-paragraph'],
  },
  {
    id: 'active-reader-search',
    file: 'src/features/reader/use-reader-search.ts',
    patterns: [
      'repository.searchParagraphPage',
      'activeRequestRef.current?.abort()',
      'requestGenerationRef.current',
      'readerSearchLimit',
    ],
  },
  {
    id: 'bounded-search-policy',
    file: 'src/reader/search-policy.ts',
    patterns: ['READER_CHAPTER_SEARCH_LIMIT = 200', 'READER_BOOK_SEARCH_LIMIT = 300'],
  },
  {
    id: 'revision-search-stops-at-limit',
    file: 'src/storage/reader-search-query-store.ts',
    patterns: ['readerSearchHardLimit', 'paragraphs.length >= matchLimit', 'tx.abort()', 'searchBookParagraphs'],
  },
  {
    id: 'gate-drives-real-ui',
    file: 'scripts/performance/reader-performance-gate.mjs',
    patterns: [
      'setInputFiles',
      'button[aria-label="\\ucc45 \\uac00\\uc838\\uc624\\uae30"]:visible',
      "selectOption('mixed')",
      'phase6ImportPhaseTimings(run)',
      "'.reader-scroll'",
      "'.reader-virtual-row'",
      'workerFileBytes',
      'searchTransactions',
      'startOwnedVitePreviewServer',
      'READER_DB_NAME',
    ],
  },
  {
    id: 'production-preview-default',
    file: 'scripts/performance/browser-gate-harness.mjs',
    patterns: ["'build', '--outDir'", "'preview'", "'--outDir'", "mode: 'production-preview'"],
  },
];

export async function verifyRealReaderPathContract(rootDirectory = process.cwd()) {
  const results = [];
  for (const check of CHECKS) {
    const filePath = resolve(rootDirectory, check.file);
    let source = '';
    try {
      source = await readFile(filePath, 'utf8');
    } catch (error) {
      results.push({ id: check.id, file: check.file, passed: false, missing: ['<file>'], error: String(error) });
      continue;
    }
    const missing = check.patterns.filter((pattern) => !source.includes(pattern));
    results.push({ id: check.id, file: check.file, passed: missing.length === 0, missing });
  }
  return {
    passed: results.every((result) => result.passed),
    results,
  };
}
