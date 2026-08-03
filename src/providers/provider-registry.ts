export interface ProviderIdentity {
  readonly providerId: string;
  readonly displayName: string;
}

export class ProviderRegistry<TProvider extends ProviderIdentity> {
  private readonly providers = new Map<string, TProvider>();

  constructor(providers: TProvider[] = []) {
    providers.forEach((provider) => this.register(provider));
  }

  register(provider: TProvider): void {
    if (this.providers.has(provider.providerId)) {
      throw new Error(`Provider already registered: ${provider.providerId}`);
    }
    this.providers.set(provider.providerId, provider);
  }

  get(providerId: string): TProvider {
    const provider = this.providers.get(providerId);
    if (!provider) throw new Error(`Provider not found: ${providerId}`);
    return provider;
  }

  list(): TProvider[] {
    return [...this.providers.values()];
  }

  has(providerId: string): boolean {
    return this.providers.has(providerId);
  }
}
