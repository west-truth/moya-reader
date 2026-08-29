import { describe, expect, it } from 'vitest';
import { ServerProviderTransportRegistry } from './server-provider-transport-registry.js';

interface TestProvider {
  readonly providerId: string;
}

describe('trusted server provider transport registry', () => {
  it('resolves compiled transports and exposes descriptors without factories', () => {
    const registry = new ServerProviderTransportRegistry<{ value: number }, TestProvider, 'api_key'>('AI', [
      {
        providerId: 'example',
        secretName: 'api_key',
        create: () => ({ providerId: 'example' }),
      },
    ]);

    expect(registry.create('example', { value: 1 })).toEqual({ providerId: 'example' });
    expect(registry.listDescriptors()).toEqual([{ providerId: 'example', secretName: 'api_key' }]);
    expect(registry.listDescriptors()[0]).not.toHaveProperty('create');
  });

  it('fails closed for duplicate, unknown and mismatched registrations', () => {
    const registry = new ServerProviderTransportRegistry<undefined, TestProvider>('TTS');
    registry.register({ providerId: 'example', create: () => ({ providerId: 'other' }) });

    expect(() => registry.register({ providerId: 'example', create: () => ({ providerId: 'example' }) })).toThrow(
      /Duplicate trusted TTS provider transport/,
    );
    expect(() => registry.create('unknown', undefined)).toThrow(/Unsupported TTS provider/);
    expect(() => registry.create('example', undefined)).toThrow(/mismatched provider/);
  });
});
