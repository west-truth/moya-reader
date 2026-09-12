import React from 'react';
import ReactDOM from 'react-dom/client';
import App from '../../../src/App';
import { RuntimeProvider } from '../../../src/app/runtime/RuntimeProvider';
import { createWebRuntime } from './web-runtime';
import { relayDropboxOAuthPopup } from '../../../src/cloud-vault/dropbox-oauth';
import '../../../src/styles/tokens.css';
import '../../../src/styles/base.css';
import '../../../src/styles/shell.css';
import '../../../src/styles/library.css';
import '../../../src/styles/chapters.css';
import '../../../src/styles/reader-shell.css';
import '../../../src/styles/reader-content.css';
import '../../../src/styles/reader-addons.css';
import '../../../src/styles/analysis.css';
import '../../../src/styles/reader-tools.css';
import '../../../src/styles/dialogs-import.css';
import '../../../src/styles/external-sources.css';
import '../../../src/styles/settings-sync.css';
import '../../../src/styles/feedback.css';
import '../../../src/styles/responsive.css';

if (!relayDropboxOAuthPopup()) {
  const runtime = createWebRuntime();
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <RuntimeProvider runtime={runtime}>
        <App />
      </RuntimeProvider>
    </React.StrictMode>,
  );
}
