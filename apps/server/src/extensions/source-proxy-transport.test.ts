import { describe, expect, it } from 'vitest';
import { createSourceProxyTransport } from './source-proxy-transport.js';

describe('installed source proxy transport', () => {
  it('is disabled by default and creates a host-owned transport for a valid address', () => {
    expect(createSourceProxyTransport(undefined)).toEqual({});
    expect(createSourceProxyTransport('socks5://source-egress:40000').transport).toBeTypeOf('function');
  });

  it('rejects credentials and arbitrary proxy paths before server startup', () => {
    expect(() => createSourceProxyTransport('http://user:secret@proxy:8080')).toThrow(
      'compatibility_preferences_invalid',
    );
    expect(() => createSourceProxyTransport('https://proxy:8080/path')).toThrow('compatibility_preferences_invalid');
  });
});
