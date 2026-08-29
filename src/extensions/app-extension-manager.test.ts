import type { ExtensionContributionId } from '@noveldesk/extension-contracts';
import { MOYA_EXTENSION_API_VERSION, MOYA_EXTENSION_MANIFEST_VERSION } from '@noveldesk/extension-contracts';
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

  it('rolls back persistence and runtime when enabling an extension fails', () => {
    const storage = new MemoryStorage();
    const extensionId = 'test.activation-failure' as const;
    const runtime = createAppExtensionRuntime({
      enablementStore: new ExtensionEnablementStore(storage),
      trustedRegistrations: [
        {
          definition: {
            manifest: {
              manifestVersion: MOYA_EXTENSION_MANIFEST_VERSION,
              id: extensionId,
              name: 'Activation failure fixture',
              version: '1.0.0',
              engine: { moyaApi: MOYA_EXTENSION_API_VERSION },
              permissions: [],
            },
            activate: () => {
              throw new Error('fixture activation failed');
            },
          },
          origin: 'bundled',
          trustLevel: 'trusted',
          defaultEnabled: false,
          canDisable: true,
        },
      ],
    });
    const listener = vi.fn();
    runtime.manager.subscribe(listener);

    expect(runtime.manager.setEnabled(extensionId, true)).toBe(false);
    expect(runtime.manager.isEnabled(extensionId)).toBe(false);
    expect(runtime.manager.list()).toContainEqual(
      expect.objectContaining({
        id: extensionId,
        enabled: false,
        state: 'disabled',
        errorMessage: 'fixture activation failed',
      }),
    );
    expect(listener).toHaveBeenCalledOnce();

    const restored = createAppExtensionRuntime({
      enablementStore: new ExtensionEnablementStore(storage),
      trustedRegistrations: [
        {
          definition: {
            manifest: {
              manifestVersion: MOYA_EXTENSION_MANIFEST_VERSION,
              id: extensionId,
              name: 'Activation failure fixture',
              version: '1.0.0',
              engine: { moyaApi: MOYA_EXTENSION_API_VERSION },
              permissions: [],
            },
            activate: () => undefined,
          },
          origin: 'bundled',
          trustLevel: 'trusted',
          defaultEnabled: false,
          canDisable: true,
        },
      ],
    });
    expect(restored.manager.isEnabled(extensionId)).toBe(false);
    expect(restored.manager.list()).toContainEqual(expect.objectContaining({ state: 'disabled' }));
  });

  it('does not execute sandbox-labeled definitions in the trusted application realm', () => {
    const activate = vi.fn();
    const extensionId = 'community.unisolated' as const;
    const runtime = createAppExtensionRuntime({
      trustedRegistrations: [
        {
          definition: {
            manifest: {
              manifestVersion: MOYA_EXTENSION_MANIFEST_VERSION,
              id: extensionId,
              name: 'Unisolated community fixture',
              version: '1.0.0',
              engine: { moyaApi: MOYA_EXTENSION_API_VERSION },
              permissions: [],
            },
            activate,
          },
          origin: 'community',
          trustLevel: 'sandboxed',
          defaultEnabled: true,
          canDisable: true,
        },
      ],
    });

    expect(activate).not.toHaveBeenCalled();
    expect(runtime.manager.list()).toEqual([
      expect.objectContaining({
        id: extensionId,
        origin: 'community',
        trustLevel: 'sandboxed',
        enabled: false,
        state: 'failed',
        errorMessage: '커뮤니티 익스텐션 격리 실행 환경이 아직 제공되지 않습니다.',
      }),
    ]);
    expect(runtime.trustedExtensions.getSnapshots()).toEqual([]);
  });
});
