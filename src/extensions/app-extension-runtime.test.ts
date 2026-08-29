import { isValidElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { AIAddonPanelActions, AIWorkflowPanelData } from '../features/ai/ai-addon-panel-contract';
import { READER_INFO_ADDON_ID, READER_INFO_EXTENSION_ID } from './builtin/reader-info-extension';
import { CHARACTER_BUNDLE_ANALYSIS_WORKFLOW_ID } from './builtin/character-bundle-analysis-extension';
import { BOOK_AI_TTS_WORKFLOW_ID } from './builtin/book-ai-tts-workflow-extension';
import { MOYA_AI_ADDON_ID, MOYA_AI_EXTENSION_ID } from './builtin/moya-ai-extension';
import { libraryBookEnrichmentTrustedExtension } from './examples/library-book-enrichment-extension';
import { createAppExtensionRuntime } from './app-extension-runtime';

describe('createAppExtensionRuntime', () => {
  it('activates the bundled Reader information extension by default', () => {
    const runtime = createAppExtensionRuntime();

    expect(runtime.trustedExtensions.getReaderAddon(READER_INFO_ADDON_ID)?.descriptor).toMatchObject({
      label: '정보',
      order: 10,
    });
    expect(runtime.trustedExtensions.getSnapshots()).toContainEqual(
      expect.objectContaining({ id: READER_INFO_EXTENSION_ID, state: 'active' }),
    );
    expect(runtime.trustedExtensions.getAnalysisWorkflows().map(({ descriptor }) => descriptor.id)).toEqual([
      CHARACTER_BUNDLE_ANALYSIS_WORKFLOW_ID,
      BOOK_AI_TTS_WORKFLOW_ID,
    ]);
    expect(runtime.trustedExtensions.getSnapshots()).toContainEqual(
      expect.objectContaining({ id: MOYA_AI_EXTENSION_ID, state: 'active' }),
    );
    expect(runtime.trustedExtensions.getReaderAddon(MOYA_AI_ADDON_ID)).toBeDefined();
    expect(runtime.bookAITTSRunners.listWorkflowIds()).toEqual([BOOK_AI_TTS_WORKFLOW_ID]);
    expect(runtime.trustedExtensions.getBookEnrichmentProviders()).toEqual([]);
    expect(runtime.trustedExtensions.getExternalSources()).toEqual([]);
    expect(runtime.manager.list().map(({ id }) => id)).toEqual([MOYA_AI_EXTENSION_ID, READER_INFO_EXTENSION_ID]);
  });

  it('can build an extension-free runtime for recovery and focused tests', () => {
    const runtime = createAppExtensionRuntime({ trustedDefinitions: [] });

    expect(runtime.trustedExtensions.getReaderAddonTabs()).toEqual([]);
    expect(runtime.trustedExtensions.getAnalysisWorkflows()).toEqual([]);
    expect(runtime.trustedExtensions.getBookEnrichmentProviders()).toEqual([]);
    expect(runtime.trustedExtensions.getExternalSources()).toEqual([]);
    expect(runtime.trustedExtensions.getSnapshots()).toEqual([]);
    expect(runtime.bookAITTSRunners.listWorkflowIds()).toEqual([]);
  });

  it('keeps the enrichment sample behind an explicit development fixture option', () => {
    const runtime = createAppExtensionRuntime({
      additionalTrustedRegistrations: [
        {
          definition: libraryBookEnrichmentTrustedExtension,
          origin: 'bundled',
          trustLevel: 'trusted',
          defaultEnabled: true,
          canDisable: true,
        },
      ],
    });

    expect(runtime.trustedExtensions.getBookEnrichmentProviders()).toHaveLength(1);
    expect(runtime.manager.list()).toContainEqual(
      expect.objectContaining({ id: 'moya.library.enrichment', defaultEnabled: true }),
    );
  });

  it('dispatches the bundled character analysis through the host-owned runner', async () => {
    const run = vi.fn().mockResolvedValue('staged');
    const runtime = createAppExtensionRuntime();

    await expect(
      runtime.trustedExtensions.executeAnalysisWorkflow(CHARACTER_BUNDLE_ANALYSIS_WORKFLOW_ID, {
        characterBundleAnalysis: { enabled: true, run },
      }),
    ).resolves.toBe('staged');
    expect(run).toHaveBeenCalledOnce();
  });

  it('projects the current production AI/TTS port through the managed bundled workflow', () => {
    const runtime = createAppExtensionRuntime();
    const data = {} as AIWorkflowPanelData;
    const actions = {} as AIAddonPanelActions['workflow'];
    const surface = runtime.trustedExtensions.renderAnalysisWorkflow(BOOK_AI_TTS_WORKFLOW_ID, {
      characterBundleAnalysis: { enabled: false, run: vi.fn() },
      bookAITTS: { enabled: true, data, actions },
    });

    expect(isValidElement(surface)).toBe(true);
    if (!isValidElement<{ data: AIWorkflowPanelData; actions: AIAddonPanelActions['workflow'] }>(surface)) return;
    expect(surface.props.data).toBe(data);
    expect(surface.props.actions).toBe(actions);
  });
});
