import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { useTTSExecutionController, type TTSExecutionControllerInput } from './useTTSExecutionController';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

class TestAudioSession {
  active = false;
  stopCount = 0;
  readonly resumeResult = deferred<boolean>();

  get hasActivePlayback() {
    return this.active;
  }

  playBlob(): Promise<boolean> {
    this.active = true;
    return new Promise(() => undefined);
  }

  pause() {}

  resume(): Promise<boolean> {
    return this.resumeResult.promise;
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.stopCount += 1;
  }
}

describe('TTS execution controller', () => {
  it('adopts a surviving Android media session without stopping it on WebView teardown', async () => {
    const systemTTS = { pause: vi.fn(), resume: vi.fn(), stop: vi.fn() };
    let controller!: ReturnType<typeof useTTSExecutionController>;
    const input: TTSExecutionControllerInput = {
      systemTTS,
      bookId: 'book-a',
      chapterId: 'chapter-a',
      preserveSystemPlaybackOnUnmount: true,
    };
    function Harness() {
      controller = useTTSExecutionController(input);
      return null;
    }

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness />);
    });
    expect(systemTTS.stop).not.toHaveBeenCalled();

    await act(async () => {
      controller.syncExternalPlayback({
        active: true,
        playing: true,
        paused: false,
        utteranceId: 'sentence-5',
        itemIndex: 4,
        positionMs: 800,
        itemCount: 12,
        updatedAtMs: 1000,
        anchor: {
          kind: 'reflowable_text',
          bookId: 'book-a',
          chapterId: 'chapter-a',
          blockId: 'paragraph-3',
          blockIndex: 3,
          startOffset: 4,
          endOffset: 12,
        },
      });
    });
    expect(controller.playing).toBe(true);
    expect(controller.paused).toBe(false);
    expect(controller.index).toBe(3);

    await act(async () => controller.pause());
    expect(systemTTS.pause).toHaveBeenCalledOnce();
    await act(async () => renderer.unmount());
    expect(systemTTS.stop).not.toHaveBeenCalled();
  });

  it('does not let a stale resume failure stop the replacement session', async () => {
    const audioSession = new TestAudioSession();
    const systemTTS = { pause: vi.fn(), resume: vi.fn(), stop: vi.fn() };
    let controller!: ReturnType<typeof useTTSExecutionController>;
    const input: TTSExecutionControllerInput = {
      systemTTS,
      audioSession,
      bookId: 'book-a',
      chapterId: 'chapter-a',
    };
    function Harness() {
      controller = useTTSExecutionController(input);
      return null;
    }

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness />);
    });

    let firstSession!: number;
    await act(async () => {
      firstSession = controller.beginSession('book-a', 'chapter-a', 0)!;
      void controller.playAudio(new Blob(['first']), firstSession);
    });
    await act(async () => {
      controller.pause();
      controller.resume();
    });

    let replacementSession!: number;
    await act(async () => {
      replacementSession = controller.beginSession('book-a', 'chapter-a', 1)!;
      void controller.playAudio(new Blob(['replacement']), replacementSession);
    });
    expect(audioSession.stopCount).toBe(1);
    expect(audioSession.active).toBe(true);

    await act(async () => {
      audioSession.resumeResult.resolve(false);
      await audioSession.resumeResult.promise;
    });

    expect(audioSession.stopCount).toBe(1);
    expect(audioSession.active).toBe(true);
    await act(async () => renderer.unmount());
  });
});
