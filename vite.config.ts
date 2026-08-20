import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';

const licenseNoticeAssets = [
  ['LICENSE', 'LICENSE'],
  ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'],
  ['third_party/licenses/7z-wasm/License.txt', 'third_party/licenses/7z-wasm/License.txt'],
  ['third_party/licenses/common/LGPL-2.1.txt', 'third_party/licenses/common/LGPL-2.1.txt'],
  ['third_party/licenses/common/unRarLicense.txt', 'third_party/licenses/common/unRarLicense.txt'],
  ['third_party/licenses/node-unrar-js/LICENSE.md', 'third_party/licenses/node-unrar-js/LICENSE.md'],
] as const;

function packageLicenseNotices(): Plugin {
  return {
    name: 'moya-license-notices',
    apply: 'build',
    generateBundle() {
      for (const [sourcePath, fileName] of licenseNoticeAssets) {
        this.emitFile({ type: 'asset', fileName, source: readFileSync(sourcePath) });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), packageLicenseNotices()],
  clearScreen: false,
  server: {
    strictPort: true,
    port: 1420,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  worker: {
    format: 'es',
  },
  test: {
    exclude: [...configDefaults.exclude, 'handoff/**'],
  },
});
