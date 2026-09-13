import { startNativeExtensionHost } from './native-host';
import { EncryptedSourceCredentialVault } from '../../apps/server/src/extensions/source-credential-vault';
import { ApkExtensionHost } from '../../apps/server/src/extensions/apk-extension-host';
import { MangayomiExtensionHost } from '../../apps/server/src/extensions/mangayomi/host';
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
let buffered = '';
let started = false;
let close: (() => Promise<void>) | undefined;
const quit = () => {
  void (close?.() ?? Promise.resolve()).finally(() => process.exit(0));
};
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  if (started) {
    quit();
    return;
  }
  buffered += chunk;
  if (buffered.length > 16384) {
    process.exit(1);
  }
  if (!buffered.includes('\n')) return;
  started = true;
  void (async () => {
    const { token, origin, vaultDirectory, vaultKey } = JSON.parse(buffered);
    buffered = '';
    const vault =
      typeof vaultDirectory === 'string' && typeof vaultKey === 'string'
        ? new EncryptedSourceCredentialVault(vaultDirectory, Buffer.from(vaultKey, 'hex'))
        : undefined;
    const apkBuild = fileURLToPath(new URL('./apk-runtime/', import.meta.url));
    let apk: ApkExtensionHost | undefined;
    if (
      typeof vaultDirectory === 'string' &&
      (await access(join(apkBuild, 'target/apk-worker-0.1.0.jar')).then(
        () => true,
        () => false,
      ))
    ) {
      apk = await ApkExtensionHost.open(
        join(apkBuild, 'jre/bin', process.platform === 'win32' ? 'java.exe' : 'java'),
        apkBuild,
        join(dirname(vaultDirectory), 'apk-extensions'),
      ).catch(() => undefined);
    }
    const mangayomi =
      vault && typeof vaultDirectory === 'string'
        ? await MangayomiExtensionHost.open(join(dirname(vaultDirectory), 'mangayomi-extensions'), vault).catch(
            () => undefined,
          )
        : undefined;
    const host = await startNativeExtensionHost(token, origin, { vault, apk, mangayomi });
    close = host.close;
    process.stdout.write(JSON.stringify({ endpoint: host.endpoint }) + '\n');
  })().catch(() => process.exit(1));
});
process.stdin.on('end', quit);
process.on('SIGTERM', quit);
process.on('SIGINT', quit);
setTimeout(() => {
  if (!started) process.exit(1);
}, 10000).unref();
