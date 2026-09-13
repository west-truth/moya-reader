import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { BlobReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js';

const url =
  'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jre_x64_windows_hotspot_21.0.12.1_1.zip';
const sha256 = 'd35f31e712f0fcf6ac5a093edc90204fbff22f720ba3950bd09d331d5e621636';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Called after bundle-native cleans its verified generated output directory. */
export async function bundleApkRuntime(root, output) {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw new Error('APK desktop packaging requires Windows x64');
  if (resolve(output) !== resolve(root, 'src-tauri/extension-sidecar/apk-runtime'))
    throw new Error('Invalid APK build path');
  const service = join(root, 'services/apk-worker');
  const build = join(service, 'build');
  const dependencies = JSON.parse(await readFile(join(service, 'dependencies.lock.json'), 'utf8'));
  await mkdir(join(output, 'target'), { recursive: true });
  await cp(join(build, 'target/apk-worker-0.1.0.jar'), join(output, 'target/apk-worker-0.1.0.jar'));
  await mkdir(join(output, 'dependencies'), { recursive: true });
  for (const dependency of dependencies) {
    const path = join(build, 'dependencies', dependency.file);
    if (digest(await readFile(path)) !== dependency.sha256) throw new Error('APK dependency digest mismatch');
    await cp(path, join(output, 'dependencies', dependency.file));
  }
  const cache = process.env.MOYA_APK_JRE_ARCHIVE || join(root, '.tmp/apk-jre-win.zip');
  let archive = await readFile(cache).catch(() => undefined);
  if (!archive || digest(archive) !== sha256) {
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok || !response.body) throw new Error('Official Java download failed');
    const parts = [];
    let size = 0;
    for await (const part of response.body) {
      size += part.length;
      if (size > 64 * 1024 * 1024) throw new Error('Official Java archive too large');
      parts.push(part);
    }
    archive = Buffer.concat(parts);
    if (digest(archive) !== sha256) throw new Error('Official Java digest mismatch');
    await mkdir(dirname(cache), { recursive: true });
    await writeFile(cache, archive);
  }
  const jre = resolve(output, 'jre');
  const zip = new ZipReader(new BlobReader(new Blob([archive])), { useWebWorkers: false });
  try {
    for (const entry of await zip.getEntries()) {
      if (entry.directory) continue;
      const name = entry.filename.split('/').slice(1).join('/');
      const path = resolve(jre, name);
      if (!name || !path.startsWith(jre + sep)) throw new Error('Invalid Java archive path');
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, await entry.getData(new Uint8ArrayWriter()));
    }
  } finally {
    await zip.close();
  }
  for (const name of ['src', 'UPSTREAM-LICENSE', 'build-inventory.json'])
    await cp(join(build, name), join(output, name), { recursive: true });
  await mkdir(join(output, 'build-recipe'), { recursive: true });
  for (const name of ['build.py', 'pom.xml', 'dependencies.lock.json', 'java', 'kotlin', 'test', 'README.md'])
    await cp(join(service, name), join(output, 'build-recipe', name), { recursive: true });
  await writeFile(join(output, 'java-runtime.json'), JSON.stringify({ url, sha256 }, null, 2) + '\n');
}
