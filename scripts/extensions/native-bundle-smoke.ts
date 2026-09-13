import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { buildMoyaExtension } from '../../src/extensions/packages/package-builder';
import { verifyMoyaExtension } from '../../src/extensions/packages/package-archive';
import { examplePackageManifest } from '../../src/test/extension-package-fixture';
import { NativePackageExecution } from '../../src/platform/tauri/native-package-execution';

// Requires the real generated bundle. Never substitutes system Node or skips missing resources.
const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = resolve(root, 'src-tauri/extension-sidecar');
assert.equal(process.platform, 'win32', 'This packaged runtime gate currently targets Windows x64');
const env = Object.fromEntries(
  ['SystemRoot', 'WINDIR', 'TMP', 'TEMP'].flatMap((key) => (process.env[key] ? [[key, process.env[key]!]] : [])),
);
const child = spawn(resolve(directory, 'node.exe'), [resolve(directory, 'native-entry.mjs')], {
  cwd: directory,
  env,
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
});
const exited = once(child, 'exit');
const deadline = setTimeout(() => child.kill(), 25000);
const lines = createInterface({ input: child.stdout });
let connection: Promise<{ endpoint: string }> | undefined;
const execution = new NativePackageExecution(async <T>(_command: string, args?: Record<string, unknown>) => {
  connection ??= (async () => {
    const ready = once(lines, 'line');
    child.stdin.write(JSON.stringify({ token: args?.sessionToken, origin: 'http://tauri.localhost' }) + '\n');
    return JSON.parse((await ready)[0]) as { endpoint: string };
  })();
  return (await connection) as T;
});
const original = 'Original\r\n\r\n  Untouched bytes.\n';
const pkg = await verifyMoyaExtension(
  await buildMoyaExtension({
    manifest: examplePackageManifest(),
    license: 'Synthetic fixture',
    source: `globalThis.moyaExtension=async(method,input,host)=>{
    if(method==='describe')return{apiVersion:1,sources:[{id:'org.example.catalog.source',cover:false}]};
    if(input.query==='loop'){while(true){}}
    if(method==='source.listWorks')return{items:[{id:'one',title:'Packaged source'}]};
    if(method==='source.getContent')return{kind:'text',asset:await host.request('asset.fromText',{text:${JSON.stringify(original)}})};
  };`,
  }),
);
const sourceId = 'org.example.catalog.source';
try {
  // Exercise cache-miss recovery used after a helper restart.
  const value = await execution.invoke(
    pkg,
    'source.getContent',
    { sourceId, workId: 'one', releaseId: 'one' },
    new AbortController().signal,
  );
  assert.equal(value.assets.size, 1);
  assert.equal(await [...value.assets.values()][0].text(), original);
  const abort = new AbortController();
  const loop = execution.invoke(pkg, 'source.listWorks', { sourceId, query: 'loop' }, abort.signal);
  const rejected = assert.rejects(loop);
  await new Promise((resolve) => setTimeout(resolve, 350));
  const cancelledAt = Date.now();
  abort.abort();
  await rejected;
  assert.ok(Date.now() - cancelledAt < 2000, 'Cancellation must not wait for the guest deadline');
  const normal = await execution.invoke(pkg, 'source.listWorks', { sourceId }, new AbortController().signal);
  assert.deepEqual(normal.result, { items: [{ id: 'one', title: 'Packaged source' }] });
  const running = execution.invoke(pkg, 'source.listWorks', { sourceId, query: 'loop' }, new AbortController().signal);
  const interrupted = assert.rejects(running);
  await new Promise((resolve) => setTimeout(resolve, 350));
  const stoppedAt = Date.now();
  child.stdin.end();
  const [code] = await exited;
  await interrupted;
  assert.equal(code, 0);
  assert.ok(Date.now() - stoppedAt < 2000, 'Parent shutdown must abort and join the active guest');
  console.log(
    'Packaged native runtime passed: independent Node/QuickJS, cache recovery, raw bytes, cancellation, shutdown.',
  );
} finally {
  clearTimeout(deadline);
  lines.close();
  child.stdin.destroy();
  if (child.exitCode === null) child.kill();
}
