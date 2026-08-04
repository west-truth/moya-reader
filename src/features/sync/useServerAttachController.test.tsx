import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { Novel } from '../../domain/types';
import type { ImportController } from '../../services/import/import-service';
import { useServerAttachController, type ServerAttachControllerInput } from './useServerAttachController';

function novel(): Novel {
  return {
    id: 'book-a',
    title: 'Book A',
    sourceFilename: 'book-a.txt',
    encoding: 'utf-8',
    normalizedTextHash: 'hash-a',
    importedAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
    chapterCount: 1,
    characterCount: 1,
    favorite: false,
    lastReadProgress: 0,
    analysisStatus: 'not_started',
  };
}

describe('server attach controller', () => {
  it('does not run completion callbacks after unmount', async () => {
    let resolveAttach!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolveAttach = resolve;
    });
    const importController: ImportController = { promise, cancel: vi.fn() };
    const onAttached = vi.fn(async () => ({
      id: 'sync',
      status: 'idle' as const,
      lastPulledSequence: 0,
      nextSequence: 1,
      pendingCount: 0,
      updatedAt: '2026-07-11T00:00:00.000Z',
    }));
    const input: ServerAttachControllerInput = {
      service: { attachNovel: vi.fn(() => importController) },
      novel: novel(),
      onAttached,
      notify: vi.fn(),
    };
    let controller!: ReturnType<typeof useServerAttachController>;
    function Harness() {
      controller = useServerAttachController(input);
      return null;
    }

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness />);
    });
    let upload!: Promise<void>;
    await act(async () => {
      upload = controller.upload();
    });
    await act(async () => renderer.unmount());
    await act(async () => {
      resolveAttach();
      await upload;
    });

    expect(importController.cancel).toHaveBeenCalledOnce();
    expect(onAttached).not.toHaveBeenCalled();
  });
});
