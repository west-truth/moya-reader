import type { ExtensionContributionId } from '@noveldesk/extension-contracts';
import { describe, expect, it, vi } from 'vitest';
import { createAppExtensionRuntime } from './app-extension-runtime';
import { BOOK_AI_TTS_WORKFLOW_ID } from './builtin/book-ai-tts-workflow-extension';
import { MOYA_AI_ADDON_ID, MOYA_AI_EXTENSION_ID } from './builtin/moya-ai-extension';
import { READER_INFO_ADDON_ID } from './builtin/reader-info-extension';
import { ExtensionEnablementStore, type ExtensionEnablementStorage } from './extension-enablement-store';

class MemoryStorage implements ExtensionEnablementStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe('AppExtensionManager', () => {
  it('reactively removes every contribution from a disabled extension', () => {
    const runtime = createAppExtensionRuntime({ enablementStore: new ExtensionEnablementStore(null) });
    const listener = vi.fn();
    const unsubscribe = runtime.manager.subscribe(listener);

    expect(runtime.manager.setEnabled(MOYA_AI_EXTENSION_ID, false)).toBe(true);

    expect(listener).toHaveBeenCalledOnce();
    expect(runtime.trustedExtensions.getReaderAddon(MOYA_AI_ADDON_ID)).toBeUndefined();
    expect(runtime.trustedExtensions.getAnalysisWorkflow(BOOK_AI_TTS_WORKFLOW_ID)).toBeUndefined();
    expect(runtime.trustedExtensions.getReaderAddon(READER_INFO_ADDON_ID)).toBeDefined();
    expect(runtime.manager.list()).toContainEqual(
      expect.objectContaining({ id: MOYA_AI_EXTENSION_ID, enabled: false, state: 'disabled' }),
    );
    unsubscribe();
  });

  it('restores the device-local choice before activating contributions', () => {
    const storage = new MemoryStorage();
    const first = createAppExtensionRuntime({ enablementStore: new ExtensionEnablementStore(storage) });
    first.manager.setEnabled(MOYA_AI_EXTENSION_ID, false);

    const restored = createAppExtensionRuntime({ enablementStore: new ExtensionEnablementStore(storage) });

    expect(restored.manager.isEnabled(MOYA_AI_EXTENSION_ID)).toBe(false);
    expect(restored.trustedExtensions.getReaderAddon(MOYA_AI_ADDON_ID)).toBeUndefined();
    expect(restored.trustedExtensions.getAnalysisWorkflow(BOOK_AI_TTS_WORKFLOW_ID)).toBeUndefined();
  });

  it('rejects unknown extension ids without publishing a revision', () => {
    const runtime = createAppExtensionRuntime({ enablementStore: new ExtensionEnablementStore(null) });
    const listener = vi.fn();
    runtime.manager.subscribe(listener);

    expect(runtime.manager.setEnabled('unknown.extension' as ExtensionContributionId, false)).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });
});
