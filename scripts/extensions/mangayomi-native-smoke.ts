import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { MangayomiExtensionHost } from '../../apps/server/src/extensions/mangayomi/host';
import { EncryptedSourceCredentialVault } from '../../apps/server/src/extensions/source-credential-vault';
import { fixtureRow, fixtureSource } from '../../apps/server/src/extensions/mangayomi/test-fixture';
import { buildMoyaExtension } from '../../src/extensions/packages/package-builder';
import { verifyMoyaExtension } from '../../src/extensions/packages/package-archive';
import { examplePackageManifest } from '../../src/test/extension-package-fixture';
import { NativePackageExecution } from '../../src/platform/tauri/native-package-execution';

// Requires the real generated bundle. Never substitutes system Node or skips missing resources.
const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = resolve(root, 'src-tauri/extension-sidecar');
assert.equal(process.platform, 'win32', 'This packaged runtime gate currently targets Windows x64');
const temporary = await mkdtemp(join(tmpdir(), 'moya-native-mangayomi-'));
const vaultDirectory = join(temporary, 'vault'),
  vaultKey = '23'.repeat(32);
const installed = await MangayomiExtensionHost.open(
  join(temporary, 'mangayomi-extensions'),
  new EncryptedSourceCredentialVault(vaultDirectory, Buffer.from(vaultKey, 'hex')),
  async (input) => ({
    bytes: Buffer.from(input.url.endsWith('.json') ? JSON.stringify([fixtureRow]) : fixtureSource),
    statusCode: 200,
    headers: {},
    contentType: 'application/json',
    url: input.url,
  }),
);
await installed.refreshRepository('https://repo.example/index.min.json', new AbortController().signal);
const entry = installed.snapshot().repositories[0].entries[0];
const review = await installed.inspect(
  'https://repo.example/index.min.json',
  entry.pkg,
  entry.code,
  new AbortController().signal,
);
await installed.install(review.id, review.revision, new AbortController().signal);
installed.close();
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
    child.stdin.write(
      JSON.stringify({ token: args?.sessionToken, origin: 'http://tauri.localhost', vaultDirectory, vaultKey }) + '\n',
    );
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
  const inventory = (await execution.mangayomi.request({ action: 'list' })) as {
    available: boolean;
    sources: { descriptor: { id: string } }[];
  };
  assert(inventory.available);
  assert.equal(inventory.sources.length, 1);
  const listing = await execution.mangayomi.invoke(
    inventory.sources[0].descriptor.id,
    'source.listWorks',
    {},
    new AbortController().signal,
  );
  assert.equal((listing.result as { items: { title: string }[] }).items[0].title, 'Novel image');
  console.log('Packaged Mangayomi original JS and bundled DOM passed');
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
  if (child.exitCode === null) {
    child.kill();
    await exited;
  }
  await rm(temporary, { recursive: true, force: true });
}
