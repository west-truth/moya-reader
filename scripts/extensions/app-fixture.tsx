/// <reference types="vite/client" />
/// <reference lib="dom.iterable" />
// Whole production App with local book storage and a real Hosted or bundled native source runtime.
// This fixture is served only by app-browser-smoke.ts, never by a product entrypoint.
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from '../../src/App';
import { RuntimeProvider } from '../../src/app/runtime/RuntimeProvider';
import { createAppRuntime } from '../../src/app/runtime/app-runtime';
import { createReaderRuntime } from '../../src/repositories/reader-runtime';
import { RemoteApiClient } from '../../src/services/remote/remote-api-client';
import { createWebProviderRuntime } from '../../apps/web/src/web-runtime';
import { readDocumentSeriesArchive } from '@noveldesk/document-series-core';
import '../../src/styles/tokens.css';
import '../../src/styles/base.css';
import '../../src/styles/shell.css';
import '../../src/styles/library.css';
import '../../src/styles/chapters.css';
import '../../src/styles/reader-shell.css';
import '../../src/styles/reader-content.css';
import '../../src/styles/reader-addons.css';
import '../../src/styles/analysis.css';
import '../../src/styles/reader-tools.css';
import '../../src/styles/dialogs-import.css';
import '../../src/styles/external-sources.css';
import '../../src/styles/settings-sync.css';
import '../../src/styles/feedback.css';
import '../../src/styles/responsive.css';

const nativeFixture = new URLSearchParams(location.search).has('native');
const runtime = createAppRuntime({
  readerRuntimeFactory: () => createReaderRuntime({ mode: 'local', allowServerSync: false }),
  providerRuntimeFactory: createWebProviderRuntime,
  platformRuntimeDetector: () => ({
    kind: nativeFixture ? 'tauri-desktop' : 'browser',
    hasTauri: false,
    isMobileWebView: false,
    userAgent: navigator.userAgent,
  }),
});
const api = new RemoteApiClient('/api', { getAuthToken: () => 'fixture-token' });
const extensionAppFixture = {
  reader: runtime.readerRuntime.readerRepository,
  assets: runtime.readerRuntime.bookAssetRepository,
  async inspect() {
    const reader = runtime.readerRuntime.readerRepository;
    return Promise.all(
      (await reader.listNovels()).map(async (novel) => {
        const chapters = await reader.listChapters(novel.id);
        const archive = await runtime.readerRuntime.bookAssetRepository?.exportSource(novel.id);
        const series = archive && (await readDocumentSeriesArchive(archive.blob));
        return {
          id: novel.id,
          chapters: chapters.map((chapter) => ({ id: chapter.id, title: chapter.title })),
          position: await reader.getReadingPosition(novel.id),
          bodies: series ? await Promise.all([...series.sources.values()].map((blob) => blob.text())) : [],
        };
      }),
    );
  },
};
export type ExtensionAppFixture = typeof extensionAppFixture;
Object.assign(globalThis, { extensionAppFixture });
createRoot(document.getElementById('root')!).render(
  <RuntimeProvider runtime={{ ...runtime, providerApiClient: nativeFixture ? undefined : api }}>
    <App />
  </RuntimeProvider>,
);
