import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webPwaPlugin } from './scripts/web-pwa-plugin';

const appRoot = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(appRoot, '../..');

/** Read shared branding/licences in place, both for dev and the standalone static artifact. */
function sharedPublicAssets(): Plugin {
  const entries = new Map<string, string>();
  for (const folder of ['icons', 'branding']) {
    for (const name of readdirSync(resolve(repoRoot, 'public', folder)))
      entries.set(`${folder}/${name}`, resolve(repoRoot, 'public', folder, name));
  }
  for (const name of [
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    'third_party/licenses/7z-wasm/License.txt',
    'third_party/licenses/common/LGPL-2.1.txt',
    'third_party/licenses/common/unRarLicense.txt',
    'third_party/licenses/node-unrar-js/LICENSE.md',
  ])
    entries.set(name, resolve(repoRoot, name));
  return {
    name: 'moya-shared-public-assets',
    generateBundle() {
      for (const [fileName, source] of entries)
        this.emitFile({ type: 'asset', fileName, source: readFileSync(source) });
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = (req.url ?? '').split('?')[0].slice(1);
        const source = entries.get(name);
        if (!source || !['GET', 'HEAD'].includes(req.method ?? '')) return next();
        res.setHeader('Content-Type', name.endsWith('.png') ? 'image/png' : 'text/plain; charset=utf-8');
        res.end(req.method === 'HEAD' ? undefined : readFileSync(source));
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  base: loadEnv(mode, appRoot, 'WEB_BASE_PATH').WEB_BASE_PATH || '/',
  root: appRoot,
  envDir: appRoot,
  plugins: [react(), sharedPublicAssets(), webPwaPlugin()],
  server: { host: '127.0.0.1', port: 1422, strictPort: true, fs: { allow: [repoRoot] } },
  preview: { host: '127.0.0.1', port: 4174, strictPort: true },
  worker: { format: 'es' },
  envPrefix: [
    'VITE_DROPBOX_APP_KEY',
    'VITE_DROPBOX_SOURCE_APP_KEY',
    'VITE_GOOGLE_DRIVE_CLIENT_ID',
    'VITE_GOOGLE_DRIVE_APP_ID',
    'VITE_GOOGLE_DRIVE_DEVELOPER_KEY',
    'VITE_DESKTOP_DOWNLOAD_URL',
  ],
  define: {
    'import.meta.env.VITE_READER_BACKEND': JSON.stringify('local'),
    'import.meta.env.VITE_API_BASE_URL': JSON.stringify(''),
    'import.meta.env.VITE_SYNC_API_BASE_URL': JSON.stringify(''),
    'import.meta.env.VITE_API_AUTH_TOKEN': JSON.stringify(''),
  },
}));
