import {
  SOURCE_BROWSER_MODE_KEY,
  sourceBrowserMode,
  sourceBrowserModeField,
  type SourceBrowserMode,
} from './source-browser-mode.js';
import type { VerifiedMoyaPackage } from '../../../../src/extensions/packages/package-archive.js';
import type { SourceCredentialVault } from './source-credential-vault.js';
import type { CompatibilityPreferences } from '../../../../src/extensions/packages/compatibility-preferences.js';
import {
  validSourcePreferencesRequest,
  validSourcePreferenceValue,
  type SourcePreferencesRequest,
  type SourcePreferenceValue,
} from '../../../../packages/extension-contracts/source-preferences.js';

export function createSourcePreferences(vault: SourceCredentialVault) {
  const key = (pkg: string, source: string, epoch: string) => JSON.stringify([pkg, `preferences:${source}`, epoch]);
  const read = (
    pkg: string,
    source: string,
    epoch: string,
  ): {
    browserMode?: SourceBrowserMode;
    revision: number;
    values: Record<string, SourcePreferenceValue>;
    privateOrigins: string[];
  } => {
    const secret = vault.read(key(pkg, source, epoch))?.secret;
    return secret ? JSON.parse(secret) : { revision: 0, values: {}, privateOrigins: [] };
  };
  return {
    values(pkg: VerifiedMoyaPackage, source: string, epoch: string) {
      const saved = read(pkg.manifest.extension.id, source, epoch);
      const fields = pkg.manifest.preferences?.find((row) => row.sourceId === source)?.fields ?? [];
      const serviceOrigins = fields
        .filter((field) => field.networkOrigin && saved.values[field.key])
        .map((field) => new URL(String(saved.values[field.key])).origin);
      return {
        ...saved,
        privateOrigins: [...new Set([...saved.privateOrigins, ...serviceOrigins])],
        values: Object.fromEntries(
          fields.flatMap((field) => {
            const value = saved.values[field.key] ?? field.defaultValue;
            return value === undefined ? [] : [[field.key, value]];
          }),
        ) as Record<string, SourcePreferenceValue>,
      };
    },
    manage(
      pkg: VerifiedMoyaPackage,
      source: string,
      epoch: string,
      request: SourcePreferencesRequest,
      signal: AbortSignal,
    ): CompatibilityPreferences {
      if (!validSourcePreferencesRequest(request) || !/^[A-Za-z0-9_-]{1,100}$/.test(epoch))
        throw new Error('invalid_source_preferences');
      const fields = pkg.manifest.preferences?.find((row) => row.sourceId === source)?.fields;
      if (!fields) throw new Error('invalid_source_preferences');
      const saved = read(pkg.manifest.extension.id, source, epoch);
      if (request.action === 'save') {
        if (saved.revision !== request.revision) throw new Error('source_preferences_conflict');
        for (const [name, value] of Object.entries(request.changes)) {
          if (name === SOURCE_BROWSER_MODE_KEY && pkg.manifest.requestedAccess.webview) {
            saved.browserMode = sourceBrowserMode(value);
            continue;
          }
          const field = fields.find((row) => row.key === name);
          if (!field || (value !== null && !validSourcePreferenceValue(field, value)))
            throw new Error('invalid_source_preferences');
          if (field.networkOrigin && value) {
            const url = new URL(String(value));
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search)
              throw new Error('invalid_source_preferences');
          }
          if (value === null) delete saved.values[name];
          else saved.values[name] = value;
        }
        saved.privateOrigins = [...new Set(request.privateOrigins)];
        saved.revision++;
        const secret = JSON.stringify(saved);
        if (Buffer.byteLength(secret) > 48 * 1024) throw new Error('invalid_source_preferences');
        signal.throwIfAborted();
        vault.write(key(pkg.manifest.extension.id, source, epoch), { secret });
      }
      signal.throwIfAborted();
      return {
        revision: saved.revision,
        privateOrigins: saved.privateOrigins,
        networkPolicy: 'restricted',
        fields: [
          ...(pkg.manifest.requestedAccess.webview ? [sourceBrowserModeField(saved.browserMode)] : []),
          ...fields
            .filter((field) => field.key !== SOURCE_BROWSER_MODE_KEY)
            .map(({ defaultValue, ...field }) => ({
              ...field,
              ...(field.secret
                ? { configured: !!saved.values[field.key] }
                : { value: saved.values[field.key] ?? defaultValue }),
            })),
        ],
      };
    },
  };
}
