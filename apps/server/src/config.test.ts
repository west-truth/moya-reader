import { describe, expect, it } from 'vitest';
import { assertSecureServerConfig, corsAllowedOrigins, loadConfig, serverExposure } from './config.js';

describe('server security config', () => {
  it('defaults local development to a loopback listener and local reader origins', () => {
    const config = loadConfig({});

    expect(config.host).toBe('127.0.0.1');
    expect(serverExposure(config)).toBe('loopback');
    expect(corsAllowedOrigins(config)).toContain('http://127.0.0.1:1421');
    expect(corsAllowedOrigins(config)).toContain('http://127.0.0.1:8080');
    expect(corsAllowedOrigins(config)).toContain('tauri://localhost');
    expect(corsAllowedOrigins(config)).not.toContain('*');
    expect(config.providerJobAdmission).toEqual({
      maxActiveAttempts: 4,
      maxAttemptsPerMinute: 60,
      maxAttemptsPerUtcDay: 1000,
    });
    expect(config.trustedProxyHops).toBe(0);
    expect(() => assertSecureServerConfig(config)).not.toThrow();
  });

  it('builds a safe PostgreSQL URL from Compose fields with reserved password characters', () => {
    const config = loadConfig({
      DATABASE_URL: '',
      PGHOST: 'postgres',
      PGPORT: '5432',
      PGUSER: 'noveldesk',
      PGPASSWORD: 'p@ss/#?word',
      PGDATABASE: 'noveldesk',
    });

    expect(config.databaseUrl).toBe('postgres://noveldesk:p%40ss%2F%23%3Fword@postgres:5432/noveldesk');
  });

  it('keeps an explicit external DATABASE_URL authoritative', () => {
    expect(
      loadConfig({
        DATABASE_URL: 'postgres://external:secret@db.example:5433/library',
        PGHOST: 'postgres',
      }).databaseUrl,
    ).toBe('postgres://external:secret@db.example:5433/library');
  });

  it('requires authentication for wildcard/external listeners', () => {
    const config = loadConfig({ HOST: '0.0.0.0' });

    expect(serverExposure(config)).toBe('external');
    expect(() => assertSecureServerConfig(config)).toThrow(/READER_AUTH_TOKEN is required/);
  });

  it('treats production as externally exposed unless loopback exposure is explicit', () => {
    const config = loadConfig({ NODE_ENV: 'production', HOST: '127.0.0.1' });

    expect(serverExposure(config)).toBe('external');
    expect(() => assertSecureServerConfig(config)).toThrow(/READER_AUTH_TOKEN is required/);
  });

  it('accepts an authenticated external deployment with an exact CORS allowlist', () => {
    const config = loadConfig({
      HOST: '0.0.0.0',
      READER_AUTH_TOKEN: 'server-token',
      CORS_ALLOWED_ORIGINS: 'https://reader.example, http://127.0.0.1:1421/',
    });

    expect(corsAllowedOrigins(config)).toEqual(['https://reader.example', 'http://127.0.0.1:1421']);
    expect(() => assertSecureServerConfig(config)).not.toThrow();
  });

  it.each(['*', 'null', 'https://reader.example/path', 'https://user:password@reader.example'])(
    'rejects unsafe CORS origin %s',
    (origin) => {
      expect(() => loadConfig({ CORS_ALLOWED_ORIGINS: origin })).toThrow(/CORS_ALLOWED_ORIGINS/);
    },
  );

  it('rejects an invalid explicit exposure value', () => {
    expect(() => loadConfig({ SERVER_EXPOSURE: 'public' })).toThrow(/SERVER_EXPOSURE/);
  });

  it('accepts explicit zero as unlimited and parses personal admission overrides', () => {
    const config = loadConfig({
      PROVIDER_MAX_ACTIVE_ATTEMPTS: '0',
      PROVIDER_MAX_ATTEMPTS_PER_MINUTE: '12',
      PROVIDER_MAX_ATTEMPTS_PER_UTC_DAY: '250',
    });

    expect(config.providerJobAdmission).toEqual({
      maxActiveAttempts: 0,
      maxAttemptsPerMinute: 12,
      maxAttemptsPerUtcDay: 250,
    });
  });

  it('accepts only a small explicit reverse-proxy hop count', () => {
    expect(loadConfig({ TRUSTED_PROXY_HOPS: '2' }).trustedProxyHops).toBe(2);
    expect(() => loadConfig({ TRUSTED_PROXY_HOPS: '5' })).toThrow(/TRUSTED_PROXY_HOPS/);
  });

  it.each(['-1', '1.5', 'many', '9007199254740992'])('rejects invalid provider admission limit %s', (value) => {
    expect(() => loadConfig({ PROVIDER_MAX_ATTEMPTS_PER_MINUTE: value })).toThrow(/PROVIDER_MAX_ATTEMPTS_PER_MINUTE/);
  });

  it.each([
    ['PORT', '0'],
    ['PORT', '65536'],
    ['MAX_CHUNK_BYTES', '-1'],
    ['MAX_CHUNK_BYTES', '1.5'],
    ['MAX_UPLOAD_BYTES', 'many'],
    ['STALE_UPLOAD_MAX_AGE_MS', '-1'],
  ])('rejects invalid bounded server setting %s=%s', (key, value) => {
    expect(() => loadConfig({ [key]: value })).toThrow(new RegExp(key));
  });

  it('accepts an explicit zero only for stale upload cleanup', () => {
    const config = loadConfig({ STALE_UPLOAD_MAX_AGE_MS: '0' });

    expect(config.staleUploadMaxAgeMs).toBe(0);
  });

  it('accepts an optional internal metadata collector URL without exposing it to the browser', () => {
    const config = loadConfig({
      WEBNOVEL_METADATA_COLLECTOR_URL: 'http://metadata-collector:8000/',
      WEBNOVEL_METADATA_COLLECTOR_REMOTE_AUTH_ENABLED: 'true',
    });

    expect(config.webNovelMetadataCollectorUrl).toBe('http://metadata-collector:8000');
    expect(config.webNovelMetadataCollectorRemoteAuthEnabled).toBe(true);
  });

  it.each([
    'file:///tmp/collector',
    'http://user:password@metadata-collector:8000',
    'http://metadata-collector:8000?token=secret',
  ])('rejects unsafe metadata collector URL %s', (value) => {
    expect(() => loadConfig({ WEBNOVEL_METADATA_COLLECTOR_URL: value })).toThrow(/WEBNOVEL_METADATA_COLLECTOR_URL/);
  });
});
