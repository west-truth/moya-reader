import type { ProviderSecretStatus, ProviderSettingsScope } from './provider-jobs';
import type { TTSVoice } from './tts';
import type { RemoteApiClient, RemoteProviderCatalog } from '../services/remote/remote-api-client';

export interface ProviderSecretControlResponse {
  readonly status?: ProviderSecretStatus;
  readonly catalog?: RemoteProviderCatalog;
  readonly secretStatuses?: ProviderSecretStatus[];
  readonly ok?: true;
  readonly message?: string;
}

export interface ProviderControlClient {
  saveProviderSecret(
    scope: ProviderSettingsScope,
    providerId: string,
    secretName: string,
    secretValue: string,
  ): Promise<ProviderSecretControlResponse>;
  deleteProviderSecret(
    scope: ProviderSettingsScope,
    providerId: string,
    secretName: string,
  ): Promise<ProviderSecretControlResponse>;
  getProviderSecretStatus?(
    scope: ProviderSettingsScope,
    providerId: string,
    secretName: string,
  ): Promise<ProviderSecretControlResponse>;
  testProviderSecret(
    scope: ProviderSettingsScope,
    providerId: string,
    secretName: string,
  ): Promise<ProviderSecretControlResponse>;
  listTTSProviderVoices?(providerId: string): Promise<{ voices: TTSVoice[] }>;
}

export class RemoteProviderControlClient implements ProviderControlClient {
  constructor(private readonly apiClient: RemoteApiClient) {}

  saveProviderSecret(
    scope: ProviderSettingsScope,
    providerId: string,
    secretName: string,
    secretValue: string,
  ): Promise<ProviderSecretControlResponse> {
    return this.apiClient.saveProviderSecret(scope, providerId, secretName, secretValue);
  }

  deleteProviderSecret(
    scope: ProviderSettingsScope,
    providerId: string,
    secretName: string,
  ): Promise<ProviderSecretControlResponse> {
    return this.apiClient.deleteProviderSecret(scope, providerId, secretName);
  }

  testProviderSecret(
    scope: ProviderSettingsScope,
    providerId: string,
    secretName: string,
  ): Promise<ProviderSecretControlResponse> {
    return this.apiClient.testProviderSecret(scope, providerId, secretName);
  }

  getProviderSecretStatus(
    scope: ProviderSettingsScope,
    providerId: string,
    secretName: string,
  ): Promise<ProviderSecretControlResponse> {
    return this.testProviderSecret(scope, providerId, secretName).catch(() => ({
      status: { scope, providerId, secretName, configured: false },
    }));
  }

  listTTSProviderVoices(providerId: string): Promise<{ voices: TTSVoice[] }> {
    return this.apiClient.listTTSProviderVoices(providerId);
  }
}

type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export class DesktopProviderControlClient implements ProviderControlClient {
  private invokePromise?: Promise<TauriInvoke>;

  async saveProviderSecret(
    scope: ProviderSettingsScope,
    providerId: string,
    secretName: string,
    secretValue: string,
  ): Promise<ProviderSecretControlResponse> {
    return {
      status: await this.invoke<ProviderSecretStatus>('provider_secret_set', {
        scope,
        providerId,
        secretName,
        secretValue,
      }),
    };
  }

  async deleteProviderSecret(
    scope: ProviderSettingsScope,
    providerId: string,
    secretName: string,
  ): Promise<ProviderSecretControlResponse> {
    return {
      status: await this.invoke<ProviderSecretStatus>('provider_secret_delete', {
        scope,
        providerId,
        secretName,
      }),
    };
  }

  async testProviderSecret(
    scope: ProviderSettingsScope,
    providerId: string,
    secretName: string,
  ): Promise<ProviderSecretControlResponse> {
    return {
      ok: true,
      status: await this.invoke<ProviderSecretStatus>('provider_secret_test', {
        scope,
        providerId,
        secretName,
      }),
    };
  }

  async getProviderSecretStatus(
    scope: ProviderSettingsScope,
    providerId: string,
    secretName: string,
  ): Promise<ProviderSecretControlResponse> {
    return {
      status: await this.invoke<ProviderSecretStatus>('provider_secret_status', {
        scope,
        providerId,
        secretName,
      }),
    };
  }

  async listTTSProviderVoices(providerId: string): Promise<{ voices: TTSVoice[] }> {
    const { listDesktopTTSVoices } = await import('./desktop-tts-provider');
    return listDesktopTTSVoices(providerId, this.invoke.bind(this) as TauriInvoke);
  }

  private async invoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
    const invoke = await this.loadInvoke();
    return invoke<T>(command, args);
  }

  private loadInvoke(): Promise<TauriInvoke> {
    this.invokePromise ??= import('@tauri-apps/api/core')
      .then((module) => module.invoke as TauriInvoke)
      .catch(() => {
        throw new Error('Desktop provider secret store is unavailable in this environment');
      });
    return this.invokePromise;
  }
}
