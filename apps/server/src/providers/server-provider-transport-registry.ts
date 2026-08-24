export interface ServerProviderTransportDescriptor<TSecretName extends string = string> {
  readonly providerId: string;
  readonly secretName?: TSecretName;
}

export interface ServerProviderTransportRegistration<
  TInput,
  TProvider,
  TSecretName extends string = string,
> extends ServerProviderTransportDescriptor<TSecretName> {
  create(input: TInput): TProvider;
}

/**
 * Privileged, source-reviewed provider transports compiled into the server.
 * It is deliberately not mutable through extension/community manifests.
 */
export class ServerProviderTransportRegistry<
  TInput,
  TProvider extends { readonly providerId: string },
  TSecretName extends string = string,
> {
  private readonly registrations = new Map<
    string,
    ServerProviderTransportRegistration<TInput, TProvider, TSecretName>
  >();

  constructor(
    private readonly providerKind: string,
    registrations: readonly ServerProviderTransportRegistration<TInput, TProvider, TSecretName>[] = [],
  ) {
    for (const registration of registrations) this.register(registration);
  }

  register(registration: ServerProviderTransportRegistration<TInput, TProvider, TSecretName>): void {
    if (!registration.providerId.trim()) throw new Error(`${this.providerKind} provider id is required`);
    if (this.registrations.has(registration.providerId)) {
      throw new Error(`Duplicate trusted ${this.providerKind} provider transport: ${registration.providerId}`);
    }
    this.registrations.set(registration.providerId, registration);
  }

  get(providerId: string): ServerProviderTransportRegistration<TInput, TProvider, TSecretName> | undefined {
    return this.registrations.get(providerId);
  }

  create(providerId: string, input: TInput): TProvider {
    const registration = this.registrations.get(providerId);
    if (!registration) throw new Error(`Unsupported ${this.providerKind} provider: ${providerId}`);
    const provider = registration.create(input);
    if (provider.providerId !== providerId) {
      throw new Error(
        `Trusted ${this.providerKind} provider transport ${providerId} returned mismatched provider ${provider.providerId}`,
      );
    }
    return provider;
  }

  listDescriptors(): readonly ServerProviderTransportDescriptor<TSecretName>[] {
    return [...this.registrations.values()].map(({ providerId, secretName }) => ({ providerId, secretName }));
  }
}
