import { describe, expect, it } from 'vitest';
import { assertSecureServerConfig, corsAllowedOrigins, loadConfig, serverExposure } from './config.js';

describe('server security config', () => {
  it('defaults local development to a loopback listener and local reader origins', () => {
    const config = loadConfig({});

    expect(config.host).toBe('127.0.0.1');
    expect(serverExposure(config)).toBe('loopback');
    expect(corsAllowedOrigins(config)).toContain('http://127.0.0.1:1420');
    expect(corsAllowedOrigins(config)).toContain('http://127.0.0.1:8080');
    expect(corsAllowedOrigins(config)).toContain('tauri://localhost');
    expect(corsAllowedOrigins(config)).not.toContain('*');
    expect(config.providerJobAdmission).toEqual({
      maxActiveAttempts: 4,
      maxAttemptsPerMinute: 60,
      maxAttemptsPerUtcDay: 1000,
    });
    expect(() => assertSecureServerConfig(config)).not.toThrow();
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
      CORS_ALLOWED_ORIGINS: 'https://reader.example, http://127.0.0.1:1420/',
    });

    expect(corsAllowedOrigins(config)).toEqual(['https://reader.example', 'http://127.0.0.1:1420']);
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

  it.each(['-1', '1.5', 'many', '9007199254740992'])('rejects invalid provider admission limit %s', (value) => {
    expect(() => loadConfig({ PROVIDER_MAX_ATTEMPTS_PER_MINUTE: value })).toThrow(/PROVIDER_MAX_ATTEMPTS_PER_MINUTE/);
  });
});
