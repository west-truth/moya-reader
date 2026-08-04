import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadServerAISettings,
  modelIdForProvider,
  providerIsEnabled,
  serverAIProviderIsImplemented,
} from './server-ai-config.js';

describe('server AI provider settings', () => {
  it('defaults to mock provider and keeps external providers disabled', () => {
    const settings = loadServerAISettings({}, process.cwd());

    expect(settings.defaultProviderId).toBe('mock');
    expect(providerIsEnabled(settings, 'mock')).toBe(true);
    expect(providerIsEnabled(settings, 'gemini-vertex')).toBe(false);
    expect(providerIsEnabled(settings, 'openai')).toBe(false);
    expect(serverAIProviderIsImplemented('gemini-vertex')).toBe(true);
    expect(serverAIProviderIsImplemented('openai')).toBe(true);
    expect(modelIdForProvider(settings, 'mock')).toBe('mock-segment-labeler-v1');
    expect(settings.secretConfiguredByProvider.openai).toBe(false);
    expect(settings.openAI.providerOptions.temperature).toBeUndefined();
  });

  it('loads Gemini Vertex settings from env project and credential file metadata', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noveldesk-vertex-'));
    const credentialsDir = path.join(tempDir, 'vertex-env');
    fs.mkdirSync(credentialsDir);
    const credentialPath = path.join(credentialsDir, 'service-account.json');
    fs.writeFileSync(credentialPath, '{"not":"used"}');

    const settings = loadServerAISettings(
      {
        AI_PROVIDER_DEFAULT: 'gemini-vertex',
        AI_PROVIDER_ENABLED: 'mock,gemini-vertex',
        AI_LABELING_MODEL_ID: 'gemini-3-flash',
        AI_LABELING_MAX_INPUT_CHARACTERS: '12345',
        GOOGLE_CLOUD_PROJECT: 'project-test',
        GOOGLE_CLOUD_LOCATION: 'global',
        VERTEX_CREDENTIALS_DIR: credentialsDir,
      },
      tempDir,
    );

    expect(settings.defaultProviderId).toBe('gemini-vertex');
    expect(providerIsEnabled(settings, 'gemini-vertex')).toBe(true);
    expect(modelIdForProvider(settings, 'gemini-vertex')).toBe('gemini-3-flash');
    expect(settings.secretConfiguredByProvider['gemini-vertex']).toBe(true);
    expect(settings.labelingMaxInputCharacters).toBe(12345);
    expect(settings.geminiVertex.providerOptions.maxOutputTokens).toBeUndefined();
    expect(settings.geminiVertex).toMatchObject({
      project: 'project-test',
      location: 'global',
      credentialsPath: credentialPath,
    });
  });

  it('can infer Gemini Vertex project id from service account metadata without exposing credential values', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noveldesk-vertex-'));
    const credentialsDir = path.join(tempDir, 'vertex-env');
    fs.mkdirSync(credentialsDir);
    const credentialPath = path.join(credentialsDir, 'service-account.json');
    fs.writeFileSync(
      credentialPath,
      JSON.stringify({
        type: 'service_account',
        project_id: 'project-from-file',
        private_key: 'must-not-leave-file',
      }),
    );

    const settings = loadServerAISettings(
      {
        AI_PROVIDER_DEFAULT: 'gemini-vertex',
        AI_PROVIDER_ENABLED: 'mock,gemini-vertex',
        AI_GEMINI_VERTEX_LABELING_MODEL_ID: 'gemini-3.1-flash-lite',
        VERTEX_CREDENTIALS_DIR: credentialsDir,
      },
      tempDir,
    );

    expect(settings.secretConfiguredByProvider['gemini-vertex']).toBe(true);
    expect(settings.geminiVertex.project).toBe('project-from-file');
    expect(JSON.stringify(settings)).not.toContain('must-not-leave-file');
    expect(settings.geminiVertex.credentialsPath).toBe(credentialPath);
  });

  it('resolves the default vertex env directory from a server package cwd', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'noveldesk-root-'));
    const serverCwd = path.join(tempRoot, 'apps', 'server');
    const credentialsDir = path.join(tempRoot, 'vertex env');
    fs.mkdirSync(serverCwd, { recursive: true });
    fs.mkdirSync(credentialsDir);
    const credentialPath = path.join(credentialsDir, 'service-account.json');
    fs.writeFileSync(
      credentialPath,
      JSON.stringify({
        project_id: 'workspace-root-project',
        private_key: 'must-not-leave-file',
      }),
    );

    const settings = loadServerAISettings(
      {
        AI_PROVIDER_ENABLED: 'mock,gemini-vertex',
        AI_GEMINI_VERTEX_LABELING_MODEL_ID: 'gemini-3.1-flash-lite',
      },
      serverCwd,
    );

    expect(settings.secretConfiguredByProvider['gemini-vertex']).toBe(true);
    expect(settings.geminiVertex.project).toBe('workspace-root-project');
    expect(settings.geminiVertex.credentialsPath).toBe(credentialPath);
    expect(JSON.stringify(settings)).not.toContain('must-not-leave-file');
  });

  it('loads provider-specific model, secret, and option settings', () => {
    const settings = loadServerAISettings(
      {
        AI_PROVIDER_ENABLED: 'mock,openai,gemini-ai-studio,anthropic',
        AI_OPENAI_LABELING_MODEL_ID: 'gpt-labeler',
        AI_GEMINI_AI_STUDIO_LABELING_MODEL_ID: 'gemini-labeler',
        AI_ANTHROPIC_LABELING_MODEL_ID: 'claude-labeler',
        AI_LABELING_TEMPERATURE: '0.1',
        AI_LABELING_TOP_P: '0.9',
        AI_LABELING_MAX_OUTPUT_TOKENS: '4096',
        AI_LABELING_REQUEST_PROFILE: 'chapter-labeling-v1',
        AI_LABELING_AUTO_REPAIR: 'true',
        OPENAI_API_KEY: 'openai-secret',
        OPENAI_BASE_URL: 'https://openai.test/v1',
        GEMINI_API_KEY: 'gemini-secret',
        ANTHROPIC_API_KEY: 'anthropic-secret',
        ANTHROPIC_BASE_URL: 'https://anthropic.test/v1',
        ANTHROPIC_VERSION: '2026-01-01',
      },
      process.cwd(),
    );

    expect(modelIdForProvider(settings, 'openai')).toBe('gpt-labeler');
    expect(modelIdForProvider(settings, 'gemini-ai-studio')).toBe('gemini-labeler');
    expect(modelIdForProvider(settings, 'anthropic')).toBe('claude-labeler');
    expect(settings.secretConfiguredByProvider.openai).toBe(true);
    expect(settings.secretConfiguredByProvider['gemini-ai-studio']).toBe(true);
    expect(settings.secretConfiguredByProvider.anthropic).toBe(true);
    expect(settings.openAI.baseUrl).toBe('https://openai.test/v1');
    expect(settings.anthropic.anthropicVersion).toBe('2026-01-01');
    expect(settings.openAI.providerOptions).toMatchObject({
      temperature: 0.1,
      topP: 0.9,
      maxOutputTokens: 4096,
      requestProfileId: 'chapter-labeling-v1',
      autoRepairOnValidationFailure: true,
    });
  });
});
