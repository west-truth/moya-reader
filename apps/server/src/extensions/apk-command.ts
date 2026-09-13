import { compatibilityFile } from './compatibility-file.js';
import { SOURCE_METHODS, validateSourceInput, type SourceMethod } from '@noveldesk/extension-contracts/source-protocol';
import type { ApkExtensionHost } from './apk-extension-host.js';
import type { MangayomiExtensionHost } from './mangayomi/host.js';
export type CompatibilityHost = ApkExtensionHost | MangayomiExtensionHost;
export async function dispatchApkCommand(host: CompatibilityHost | undefined, value: unknown, signal: AbortSignal) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('apk_input_invalid');
  const input = value as Record<string, unknown>;
  if (input.action === 'list')
    return {
      kind: 'json' as const,
      value: host
        ? { ...host.snapshot(), sources: host.catalog.getSources() }
        : { available: false, revision: 0, packages: [], repositories: [], sources: [] },
    };
  if (!host) throw new Error('apk_worker_unavailable');
  const revision = () => {
    if (!Number.isSafeInteger(input.revision) || (input.revision as number) < 0) throw new Error('apk_input_invalid');
    return input.revision as number;
  };
  switch (input.action) {
    case 'discard':
      if (typeof input.id !== 'string' || input.id.length > 128) break;
      host.discard(input.id);
      return { kind: 'json' as const, value: { discarded: true } };
    case 'preferences':
      if (typeof input.pkg !== 'string' || !('preferences' in host)) break;
      return { kind: 'json' as const, value: await host.preferences(input.pkg) };
    case 'preferences-save':
      if (typeof input.pkg !== 'string' || !('savePreferences' in host)) break;
      await host.savePreferences(input.pkg, revision(), input.values, input.privateOrigins);
      return { kind: 'json' as const, value: { saved: true } };
    case 'repository-refresh':
      if (typeof input.url !== 'string') break;
      await host.refreshRepository(input.url, signal);
      return { kind: 'json' as const, value: { updated: true } };
    case 'repository-remove':
      if (typeof input.url !== 'string') break;
      await host.removeRepository(input.url);
      return { kind: 'json' as const, value: { removed: true } };
    case 'inspect-file': {
      const file = compatibilityFile(input);
      return { kind: 'json' as const, value: await host.inspectFile(file.bytes, file.name, file.sourceIndex, signal) };
    }
    case 'inspect':
      if (typeof input.url !== 'string' || typeof input.pkg !== 'string' || !Number.isSafeInteger(input.code)) break;
      return { kind: 'json' as const, value: await host.inspect(input.url, input.pkg, input.code as number, signal) };
    case 'install':
      if (typeof input.id !== 'string' || input.trusted !== true) break;
      await host.install(input.id, revision(), signal);
      return { kind: 'json' as const, value: { installed: true } };
    case 'change':
      if (typeof input.pkg !== 'string' || !['enable', 'disable', 'remove'].includes(String(input.change))) break;
      await host.change(input.pkg, revision(), input.change as 'enable' | 'disable' | 'remove');
      return { kind: 'json' as const, value: { changed: true } };
    case 'invoke':
      if (
        typeof input.sourceId !== 'string' ||
        !SOURCE_METHODS.includes(input.method as SourceMethod) ||
        !input.input ||
        typeof input.input !== 'object' ||
        Array.isArray(input.input) ||
        !validateSourceInput(input.method as SourceMethod, { ...input.input, sourceId: input.sourceId })
      )
        break;
      return {
        kind: 'assets' as const,
        value: await host.catalog.invoke(
          input.sourceId,
          input.method as SourceMethod,
          input.input as Record<string, unknown>,
          signal,
        ),
      };
  }
  throw new Error('apk_input_invalid');
}
