import { describe, expect, it } from 'vitest';
import { DEFAULT_SUWAYOMI_BASE_URL, resolveAppPublicRuntimeConfig } from './public-runtime-config';

describe('public runtime config', () => {
  it('uses the allow-listed runtime identifiers before local VITE fallbacks', () => {
    const config = resolveAppPublicRuntimeConfig(
      {
        schemaVersion: 1,
        dropboxAppKey: ' runtime-dropbox ',
        dropboxSourceAppKey: ' runtime-source ',
        googleDriveClientId: ' runtime-client ',
        googleDriveAppId: ' 12345 ',
        googleDriveDeveloperKey: ' runtime-developer ',
        suwayomiDefaultUrl: 'https://suwayomi.example.test/',
        READER_AUTH_TOKEN: 'must-not-project',
        GOOGLE_CLIENT_SECRET: 'must-not-project',
      },
      {
        VITE_DROPBOX_APP_KEY: 'build-dropbox',
        VITE_GOOGLE_DRIVE_CLIENT_ID: 'build-client',
        VITE_SUWAYOMI_DEFAULT_URL: 'http://localhost:9999',
      },
    );

    expect(config).toEqual({
      dropbox: { appKey: 'runtime-dropbox', sourceAppKey: 'runtime-source' },
      googleDrive: {
        clientId: 'runtime-client',
        appId: '12345',
        developerKey: 'runtime-developer',
      },
      suwayomi: { defaultBaseUrl: 'https://suwayomi.example.test' },
    });
    expect(JSON.stringify(config)).not.toContain('must-not-project');
  });

  it('keeps VITE fallbacks for local development when the static runtime stub omits keys', () => {
    const config = resolveAppPublicRuntimeConfig(
      { schemaVersion: 1 },
      {
        VITE_DROPBOX_APP_KEY: 'local-dropbox',
        VITE_DROPBOX_SOURCE_APP_KEY: 'local-source',
        VITE_GOOGLE_DRIVE_CLIENT_ID: 'local-client',
        VITE_GOOGLE_DRIVE_APP_ID: '98765',
        VITE_GOOGLE_DRIVE_DEVELOPER_KEY: 'local-developer',
        VITE_SUWAYOMI_DEFAULT_URL: 'http://127.0.0.1:7654/',
      },
    );

    expect(config).toEqual({
      dropbox: { appKey: 'local-dropbox', sourceAppKey: 'local-source' },
      googleDrive: { clientId: 'local-client', appId: '98765', developerKey: 'local-developer' },
      suwayomi: { defaultBaseUrl: 'http://127.0.0.1:7654' },
    });
  });

  it('lets an explicit container value clear a baked fallback and rejects unsupported Suwayomi URLs', () => {
    const config = resolveAppPublicRuntimeConfig(
      {
        schemaVersion: 1,
        dropboxAppKey: '',
        googleDriveClientId: 42,
        suwayomiDefaultUrl: 'https://suwayomi.example.test/mihon',
      },
      {
        VITE_DROPBOX_APP_KEY: 'baked-dropbox',
        VITE_GOOGLE_DRIVE_CLIENT_ID: 'baked-client',
        VITE_SUWAYOMI_DEFAULT_URL: 'http://localhost:9999',
      },
    );

    expect(config.dropbox.appKey).toBeUndefined();
    expect(config.googleDrive.clientId).toBeUndefined();
    expect(config.suwayomi.defaultBaseUrl).toBe(DEFAULT_SUWAYOMI_BASE_URL);
  });
});
