import { useEffect, useRef } from 'react';
import type { ReaderPersonalizationRepository } from '../../repositories/reader-personalization-repository';
import { ActiveIntervalSessionRecorder } from './session-event-recorder';

export function useListeningSession(input: {
  readonly repository?: ReaderPersonalizationRepository;
  readonly bookId?: string;
  readonly active: boolean;
}): void {
  const recorderRef = useRef<ActiveIntervalSessionRecorder>();

  useEffect(() => {
    if (!input.repository || !input.bookId) {
      recorderRef.current = undefined;
      return;
    }
    const recorder = new ActiveIntervalSessionRecorder(input.repository, input.bookId, 'listening');
    recorderRef.current = recorder;
    const timer = globalThis.setInterval(() => void recorder.flush(), 30_000);
    return () => {
      globalThis.clearInterval(timer);
      recorder.setActive(false);
      void recorder.flush();
      if (recorderRef.current === recorder) recorderRef.current = undefined;
    };
  }, [input.bookId, input.repository]);

  useEffect(() => recorderRef.current?.setActive(input.active), [input.active]);
}
