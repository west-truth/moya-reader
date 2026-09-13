import { describe, expect, it } from 'vitest';
import { examplePackageManifest } from '../../../../src/test/extension-package-fixture';
import type { VerifiedMoyaPackage } from '../../../../src/extensions/packages/package-archive';
import { createSourcePreferences } from './source-preferences';
import { validSourcePreferenceDefinitions } from '../../../../packages/extension-contracts/source-preferences';
import { validateMoyaPackageManifest } from '../../../../packages/extension-contracts/package-manifest';

describe('maker-defined source preferences', () => {
  const sourceId = 'org.example.catalog.source';
  const fields = [
    { key: 'use_service', title: 'Use service', kind: 'boolean' as const, secret: false, defaultValue: false },
    { key: 'endpoint', title: 'Service', kind: 'text' as const, secret: false, networkOrigin: true },
    { key: 'token', title: 'Token', kind: 'text' as const, secret: true },
  ];
  const setup = () => {
    const manifest = examplePackageManifest();
    const pkg: VerifiedMoyaPackage = {
      manifest: { ...manifest, preferences: [{ sourceId, fields }] } as VerifiedMoyaPackage['manifest'],
      digest: 'fixture',
      source: '',
      archive: new Blob(),
    };
    const values = new Map<string, { secret: string }>();
    const store = createSourcePreferences({
      read: (key) => values.get(key),
      write: (key, value) => {
        if (value) values.set(key, value);
      },
    });
    return { store, pkg };
  };
  it('does not invent a required service or token, and masks saved secrets', () => {
    const { store, pkg } = setup();
    const signal = AbortSignal.timeout(5000);
    expect(validateMoyaPackageManifest(pkg.manifest).ok).toBe(true);
    expect(store.values(pkg, sourceId, 'epoch').values).toEqual({ use_service: false });
    const result = store.manage(
      pkg,
      sourceId,
      'epoch',
      {
        action: 'save',
        revision: 0,
        changes: { endpoint: 'http://localhost:9870', token: 'private-value', use_service: true },
        privateOrigins: [],
      },
      signal,
    );
    expect(JSON.stringify(result)).not.toContain('private-value');
    expect(result.fields.find((row) => row.key === 'token')).toMatchObject({ configured: true });
    expect(store.values(pkg, sourceId, 'epoch').privateOrigins).toEqual(['http://localhost:9870']);
    expect(store.values(pkg, sourceId, 'other').values).toEqual({ use_service: false });
    expect(() =>
      store.manage(
        pkg,
        sourceId,
        'epoch',
        { action: 'save', revision: 0, changes: { use_service: false }, privateOrigins: [] },
        signal,
      ),
    ).toThrow('source_preferences_conflict');
  });
  it('stores the host browser choice separately from maker preferences', () => {
    const { store, pkg } = setup();
    const browserPkg = {
      ...pkg,
      manifest: { ...pkg.manifest, requestedAccess: { ...pkg.manifest.requestedAccess, webview: true } },
    };
    store.manage(
      browserPkg,
      sourceId,
      'epoch',
      { action: 'save', revision: 0, changes: { __moya_webview_mode: 'patchright' }, privateOrigins: [] },
      AbortSignal.timeout(1000),
    );
    expect(store.values(browserPkg, sourceId, 'epoch').browserMode).toBe('patchright');
    expect(store.values(browserPkg, sourceId, 'epoch').values).not.toHaveProperty('__moya_webview_mode');
    expect(
      store
        .manage(browserPkg, sourceId, 'epoch', { action: 'read' }, AbortSignal.timeout(1000))
        .fields.find((f) => f.key === '__moya_webview_mode')?.value,
    ).toBe('patchright');
  });
  it('rejects defaults containing credentials and invalid source settings', () => {
    expect(
      validSourcePreferenceDefinitions([{ sourceId, fields: [{ ...fields[2], defaultValue: 'secret' }] }], [sourceId]),
    ).toBe(false);
    expect(
      validSourcePreferenceDefinitions([{ sourceId, fields: [{ ...fields[1], key: '__proto__' }] }], [sourceId]),
    ).toBe(false);
    const { store, pkg } = setup();
    expect(() =>
      store.manage(
        pkg,
        sourceId,
        'epoch',
        { action: 'save', revision: 0, changes: { unknown: true }, privateOrigins: [] },
        AbortSignal.timeout(1000),
      ),
    ).toThrow('invalid_source_preferences');
    expect(() =>
      store.manage(
        pkg,
        sourceId,
        'epoch',
        { action: 'save', revision: 0, changes: { endpoint: 'file:///data' }, privateOrigins: [] },
        AbortSignal.timeout(1000),
      ),
    ).toThrow('invalid_source_preferences');
  });
});
