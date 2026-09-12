import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import type { Plugin } from 'vite';

export function webPwaPlugin(): Plugin {
  let output: string;
  let base: string;
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
      const build = { version: digest.digest('hex').slice(0, 20), base, files: files.map((file) => base + file) };
      writeFileSync(
        resolve(output, 'sw.js'),
        template.replace("{ version: '__BUILD_VERSION__', files: [] }", JSON.stringify(build)),
      );
      writeFileSync(resolve(output, 'offline-manifest.json'), JSON.stringify(build, null, 2) + '\n');
    },
  };
}
