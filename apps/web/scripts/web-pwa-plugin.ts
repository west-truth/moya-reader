import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import type { Plugin } from 'vite';

export function webPwaPlugin(): Plugin {
  let output: string;
  let base: string;
  const initial = new Set<string>();
  return {
    name: 'moya-web-offline-assets',
    apply: 'build',
    configResolved(config) {
      output = resolve(config.root, config.build.outDir);
      base = config.base;
      if (!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(base)) {
        throw new Error('Web base must be an absolute directory path, e.g. / or /moya-reader/');
      }
    },
    generateBundle(_options, bundle) {
      const visit = (file: string) => {
        if (initial.has(file)) return;
        initial.add(file);
        const chunk = bundle[file];
        if (chunk?.type !== 'chunk') return;
        chunk.imports.forEach(visit);
        const metadata = (chunk as typeof chunk & { viteMetadata?: { importedCss: Set<string> } }).viteMetadata;
        metadata?.importedCss.forEach((css) => initial.add(css));
      };
      for (const chunk of Object.values(bundle)) {
        if (chunk.type === 'chunk' && chunk.isEntry) visit(chunk.fileName);
      }
    },
    closeBundle() {
      const files: string[] = [];
      const digest = createHash('sha256');
      function visit(directory: string) {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const full = resolve(directory, entry.name);
          if (entry.isDirectory()) visit(full);
          else {
            const name = relative(output, full).replaceAll('\\', '/');
            if (
              ['sw.js', 'runtime-config.js', '_headers', '_redirects', 'offline-manifest.json'].includes(name) ||
              name.endsWith('.map')
            )
              continue;
            files.push(name);
          }
        }
      }
      visit(output);
      files.sort();
      digest.update(base);
      for (const file of files) {
        digest.update(file);
        digest.update(readFileSync(resolve(output, file)));
      }
      const template = readFileSync(new URL('./service-worker.js', import.meta.url), 'utf8');
      digest.update(template);
      const assets = files.map((file) => {
        const bytes = readFileSync(resolve(output, file));
        return {
          url: base + file,
          bytes: bytes.length,
          integrity: 'sha256-' + createHash('sha256').update(bytes).digest('base64'),
          verify: !file.endsWith('.html'),
        };
      });
      const precache = files.filter(
        (file) =>
          initial.has(file) ||
          ['index.html', 'manifest.webmanifest', 'LICENSE', 'THIRD_PARTY_NOTICES.md'].includes(file) ||
          file.startsWith('icons/') ||
          file.startsWith('branding/'),
      );
      const build = {
        version: digest.digest('hex').slice(0, 20),
        base,
        files: files.map((file) => base + file),
        assets,
        precache: precache.map((file) => base + file),
      };
      writeFileSync(
        resolve(output, 'sw.js'),
        template.replace("{ version: '__BUILD_VERSION__', files: [] }", JSON.stringify(build)),
      );
      writeFileSync(resolve(output, 'offline-manifest.json'), JSON.stringify(build, null, 2) + '\n');
    },
  };
}
