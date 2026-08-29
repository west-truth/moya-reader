import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { createAppRuntime } from './app/runtime/app-runtime';
import { createAppExtensionRuntime } from './extensions/app-extension-runtime';
import { RuntimeProvider } from './app/runtime/RuntimeProvider';
import { relayDropboxOAuthPopup } from './cloud-vault/dropbox-oauth';
import { initializeAppCredentialStore } from './platform/secure-credentials';
import './styles/tokens.css';
import './styles/base.css';
import './styles/shell.css';
import './styles/library.css';
import './styles/chapters.css';
import './styles/reader-shell.css';
import './styles/reader-content.css';
import './styles/reader-addons.css';
import './styles/analysis.css';
import './styles/reader-tools.css';
import './styles/dialogs-import.css';
import './styles/external-sources.css';
import './styles/settings-sync.css';
import './styles/feedback.css';
import './styles/responsive.css';

function registerWebAppServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator) || !/^https?:$/.test(window.location.protocol)) return;
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((error) => {
      console.warn('PWA service worker registration failed.', error);
    });
  });
}

async function startApp(): Promise<void> {
  try {
    await initializeAppCredentialStore();
  } catch (error) {
    console.warn('Secure credential initialization failed; authenticated server features are unavailable.', error);
  }
  let additionalTrustedRegistrations:
    | NonNullable<NonNullable<Parameters<typeof createAppExtensionRuntime>[0]>['additionalTrustedRegistrations']>
    | undefined;
  if (import.meta.env.DEV && import.meta.env.VITE_ENABLE_BOOK_ENRICHMENT_SMOKE_FIXTURE === 'true') {
    const { libraryBookEnrichmentTrustedExtension } =
      await import('./extensions/examples/library-book-enrichment-extension');
    additionalTrustedRegistrations = [
      {
        definition: libraryBookEnrichmentTrustedExtension,
        origin: 'bundled' as const,
        trustLevel: 'trusted' as const,
        defaultEnabled: true,
        canDisable: true,
        description: '실제 Web 검증에만 사용하는 개발용 작품 보강 fixture입니다.',
      },
    ];
  }
  if (import.meta.env.DEV && import.meta.env.VITE_ENABLE_EXTERNAL_SOURCE_SMOKE_FIXTURE === 'true') {
    const { mockExternalSourceTrustedExtension } = await import('./extensions/examples/mock-external-source-extension');
    additionalTrustedRegistrations = [
      ...(additionalTrustedRegistrations ?? []),
      {
        definition: mockExternalSourceTrustedExtension,
        origin: 'bundled' as const,
        trustLevel: 'trusted' as const,
        defaultEnabled: true,
        canDisable: true,
        description: '실제 Web 검증에만 사용하는 개발용 외부 작품 소스 fixture입니다.',
      },
    ];
  }
  const runtime = createAppRuntime({
    extensionRuntimeFactory: () =>
      createAppExtensionRuntime({
        additionalTrustedRegistrations,
      }),
  });

  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <RuntimeProvider runtime={runtime}>
        <App />
      </RuntimeProvider>
    </React.StrictMode>,
  );
}

if (!relayDropboxOAuthPopup()) {
  registerWebAppServiceWorker();
  void startApp();
}
