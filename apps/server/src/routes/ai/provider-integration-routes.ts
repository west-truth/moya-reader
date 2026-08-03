import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import type { ServerConfig } from '../../config.js';
import { loadServerAISettings } from '../../providers/server-ai-config.js';
import { listServerProviderCatalog } from '../../providers/server-provider-catalog.js';
import { createServerTTSSynthesisProvider } from '../../providers/server-tts-provider-factory.js';
import {
  loadProviderSettingsBundle,
  modelFromSettings,
  providerEnabledBySettings,
  providerSettingsScope,
  saveProviderSettings,
} from '../../providers/server-provider-settings.js';
import {
  buildProviderSecretStatuses,
  deleteProviderSecret,
  providerSecretStatusBundle,
  providerSupportsUserSecret,
  resolveProviderSecrets,
  saveProviderSecret,
} from '../../providers/server-provider-secrets.js';
import {
  arrayOfStrings,
  nestedRecord,
  optionalStringField,
  providerSecretName,
  recordBody,
  stringField,
  stringRecord,
} from './request-contracts.js';
import { isServerTTSProviderId } from './tts-cache-contract.js';

export async function registerProviderIntegrationRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  config: ServerConfig,
): Promise<void> {
  app.get('/api/providers', async () => {
    const aiSettings = loadServerAISettings();
    const catalog = listServerProviderCatalog(process.env, aiSettings);
    const secretBundle = await providerSecretStatusBundle(pool, config, catalog, process.env);
    return secretBundle.catalog;
  });

  app.get('/api/provider-settings', async () => {
    const aiSettings = loadServerAISettings();
    const catalog = listServerProviderCatalog(process.env, aiSettings);
    const secretBundle = await providerSecretStatusBundle(pool, config, catalog, process.env);
    return {
      settings: await loadProviderSettingsBundle(pool, config, process.env, aiSettings),
      catalog: secretBundle.catalog,
      secretStatuses: secretBundle.secretStatuses,
    };
  });

  app.get('/api/provider-secrets', async () => {
    const aiSettings = loadServerAISettings();
    const catalog = listServerProviderCatalog(process.env, aiSettings);
    const secretStatuses = await buildProviderSecretStatuses(pool, config, catalog, process.env);
    return { secretStatuses };
  });

  app.put<{
    Params: { scope: string; providerId: string; secretName: string };
    Body: { secretValue?: unknown };
  }>('/api/provider-secrets/:scope/:providerId/:secretName', async (request, reply) => {
    const scope = providerSettingsScope(request.params.scope);
    const secretName = providerSecretName(request.params.secretName);
    const providerId = request.params.providerId;
    const body = recordBody(request.body);
    const secretValue = body ? stringField(body, 'secretValue') : undefined;
    if (!scope || !secretName || !providerSupportsUserSecret(scope, providerId, secretName)) {
      return reply.code(400).send({ error: 'provider secret target is invalid' });
    }
    if (!secretValue) return reply.code(400).send({ error: 'provider secret value is required' });
    try {
      const status = await saveProviderSecret(pool, config, { scope, providerId, secretName, secretValue });
      const aiSettings = loadServerAISettings();
      const catalog = listServerProviderCatalog(process.env, aiSettings);
      const secretBundle = await providerSecretStatusBundle(pool, config, catalog, process.env);
      return { status, catalog: secretBundle.catalog, secretStatuses: secretBundle.secretStatuses };
    } catch {
      return reply.code(400).send({ error: 'provider secret could not be saved' });
    }
  });

  app.delete<{
    Params: { scope: string; providerId: string; secretName: string };
  }>('/api/provider-secrets/:scope/:providerId/:secretName', async (request, reply) => {
    const scope = providerSettingsScope(request.params.scope);
    const secretName = providerSecretName(request.params.secretName);
    const providerId = request.params.providerId;
    if (!scope || !secretName || !providerSupportsUserSecret(scope, providerId, secretName)) {
      return reply.code(400).send({ error: 'provider secret target is invalid' });
    }
    await deleteProviderSecret(pool, config, scope, providerId, secretName);
    const aiSettings = loadServerAISettings();
    const catalog = listServerProviderCatalog(process.env, aiSettings);
    const secretBundle = await providerSecretStatusBundle(pool, config, catalog, process.env);
    return { ok: true, catalog: secretBundle.catalog, secretStatuses: secretBundle.secretStatuses };
  });

  app.post<{
    Params: { scope: string; providerId: string; secretName: string };
  }>('/api/provider-secrets/:scope/:providerId/:secretName/test', async (request, reply) => {
    const scope = providerSettingsScope(request.params.scope);
    const secretName = providerSecretName(request.params.secretName);
    const providerId = request.params.providerId;
    if (!scope || !secretName || !providerSupportsUserSecret(scope, providerId, secretName)) {
      return reply.code(400).send({ error: 'provider secret target is invalid' });
    }
    const aiSettings = loadServerAISettings();
    const catalog = listServerProviderCatalog(process.env, aiSettings);
    const status = (await buildProviderSecretStatuses(pool, config, catalog, process.env)).find(
      (item) => item.scope === scope && item.providerId === providerId && item.secretName === secretName,
    );
    if (!status?.configured) return reply.code(400).send({ error: 'provider secret is not configured' });
    return {
      ok: true,
      status,
      message: 'Provider secret is configured. This check does not make a live provider request.',
    };
  });

  app.get<{ Params: { providerId: string } }>('/api/tts-providers/:providerId/voices', async (request, reply) => {
    const providerId = request.params.providerId;
    if (!isServerTTSProviderId(providerId) || providerId === 'system') {
      return reply.code(400).send({ error: 'TTS provider does not support hosted voice discovery' });
    }
    const aiSettings = loadServerAISettings();
    const catalog = (
      await providerSecretStatusBundle(pool, config, listServerProviderCatalog(process.env, aiSettings), process.env)
    ).catalog;
    const catalogProvider = catalog.ttsProviders.find((provider) => provider.providerId === providerId);
    if (!catalogProvider) return reply.code(400).send({ error: 'providerId is invalid' });
    if (!catalogProvider.implemented)
      return reply.code(400).send({ error: 'TTS provider is not implemented on this server yet' });
    if (!catalogProvider.secretConfigured)
      return reply.code(400).send({ error: 'TTS provider secret is not configured on this server yet' });
    const ttsSettings = (await loadProviderSettingsBundle(pool, config, process.env, aiSettings)).ttsSynthesis;
    if (!providerEnabledBySettings(ttsSettings, providerId)) {
      return reply.code(400).send({ error: 'TTS provider is disabled by saved provider settings' });
    }
    const provider = createServerTTSSynthesisProvider({
      providerId,
      modelId: modelFromSettings(ttsSettings, providerId),
      secrets: await resolveProviderSecrets(pool, config, 'tts_synthesis', providerId),
    });
    if (!provider.listVoices) return { voices: [] };
    try {
      const voices = await provider.listVoices();
      return { voices };
    } catch {
      return reply.code(502).send({ error: 'TTS voice discovery failed' });
    }
  });

  app.put<{
    Params: { scope: string };
    Body: {
      defaultProviderId?: unknown;
      enabledProviderIds?: unknown;
      modelByProvider?: unknown;
      providerOptionsByProvider?: unknown;
    };
  }>('/api/provider-settings/:scope', async (request, reply) => {
    const scope = providerSettingsScope(request.params.scope);
    if (!scope) return reply.code(400).send({ error: 'provider settings scope is invalid' });
    const body = recordBody(request.body);
    if (!body) return reply.code(400).send({ error: 'request body is required' });
    const enabledProviderIds =
      body.enabledProviderIds === undefined ? undefined : arrayOfStrings(body.enabledProviderIds);
    const modelByProvider = body.modelByProvider === undefined ? undefined : stringRecord(body.modelByProvider);
    const providerOptionsByProvider =
      body.providerOptionsByProvider === undefined ? undefined : nestedRecord(body.providerOptionsByProvider);
    if (body.enabledProviderIds !== undefined && !enabledProviderIds) {
      return reply.code(400).send({ error: 'enabledProviderIds must be a string array' });
    }
    if (body.modelByProvider !== undefined && !modelByProvider) {
      return reply.code(400).send({ error: 'modelByProvider must be an object with string values' });
    }
    if (body.providerOptionsByProvider !== undefined && !providerOptionsByProvider) {
      return reply.code(400).send({ error: 'providerOptionsByProvider must be an object of objects' });
    }
    try {
      const aiSettings = loadServerAISettings();
      const input: {
        scope: typeof scope;
        defaultProviderId?: string;
        enabledProviderIds?: string[];
        modelByProvider?: Record<string, string>;
        providerOptionsByProvider?: Record<string, Record<string, unknown>>;
      } = { scope };
      if (Object.prototype.hasOwnProperty.call(body, 'defaultProviderId'))
        input.defaultProviderId = optionalStringField(body, 'defaultProviderId');
      if (Object.prototype.hasOwnProperty.call(body, 'enabledProviderIds'))
        input.enabledProviderIds = enabledProviderIds;
      if (Object.prototype.hasOwnProperty.call(body, 'modelByProvider')) input.modelByProvider = modelByProvider;
      if (Object.prototype.hasOwnProperty.call(body, 'providerOptionsByProvider'))
        input.providerOptionsByProvider = providerOptionsByProvider;
      const saved = await saveProviderSettings(pool, config, input, process.env, aiSettings);
      const catalog = listServerProviderCatalog(process.env, aiSettings);
      const secretBundle = await providerSecretStatusBundle(pool, config, catalog, process.env);
      return {
        settings: saved,
        catalog: secretBundle.catalog,
        secretStatuses: secretBundle.secretStatuses,
      };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
