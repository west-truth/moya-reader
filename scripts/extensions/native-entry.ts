import { startNativeExtensionHost } from './native-host';
import { SwitchableSourceCredentialVault } from '../../apps/server/src/extensions/source-credential-vault';
import { ApkExtensionHost } from '../../apps/server/src/extensions/apk-extension-host';
import { MangayomiExtensionHost } from '../../apps/server/src/extensions/mangayomi/host';
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
let buffered = '';
let started = false;
let control: ((line: string) => void) | undefined;
let close: (() => Promise<void>) | undefined;
const quit = () => {
  void (close?.() ?? Promise.resolve()).finally(() => process.exit(0));
};
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffered += chunk;
  if (buffered.length > 16384) process.exit(1);
  while (buffered.includes('\n')) {
    const end = buffered.indexOf('\n');
    const line = buffered.slice(0, end);
    buffered = buffered.slice(end + 1);
    if (started) {
      if (line === 'shutdown') quit();
      else control?.(line);
      continue;
    }
    started = true;
    void (async () => {
      const { token, origin, vaultDirectory, vaultKey, vaultConfigured } = JSON.parse(line);
      if (typeof vaultDirectory !== 'string') throw new Error('source_vault_unavailable');
      const vault = new SwitchableSourceCredentialVault(
        vaultDirectory,
        typeof vaultKey === 'string' ? Buffer.from(vaultKey, 'hex') : undefined,
        vaultConfigured === true,
      );
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
      // Mangayomi is part of the default JS runtime. A failed host is not an absent optional feature.
      const mangayomi = await MangayomiExtensionHost.open(join(dirname(vaultDirectory), 'mangayomi-extensions'), vault);
      const host = await startNativeExtensionHost(token, origin, { vault, apk, mangayomi });
      close = host.close;
      control = (line) => {
        try {
          const message = JSON.parse(line);
          if (message.command !== 'vault' || (message.key !== null && !/^[a-f0-9]{64}$/.test(message.key)))
            throw new Error('source_vault_unavailable');
          host.whenIdle(() => vault.switchKey(message.key === null ? undefined : Buffer.from(message.key, 'hex')));
          process.stdout.write(JSON.stringify({ ok: true }) + '\n');
        } catch (error) {
          process.stdout.write(
            JSON.stringify({
              error:
                error instanceof Error && error.message === 'source_vault_busy'
                  ? 'source_vault_busy'
                  : 'source_vault_unavailable',
            }) + '\n',
          );
        }
      };
      process.stdout.write(
        JSON.stringify({
          endpoint: host.endpoint,
          features: { credentialVault: typeof vaultKey === 'string', mangayomi: Boolean(mangayomi), apk: Boolean(apk) },
        }) + '\n',
      );
    })().catch(() => process.exit(1));
  }
});
process.stdin.on('end', quit);
process.on('SIGTERM', quit);
process.on('SIGINT', quit);
setTimeout(() => {
  if (!started) process.exit(1);
}, 10000).unref();
