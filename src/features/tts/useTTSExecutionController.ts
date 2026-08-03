import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ActiveTTSPlayback } from '../../providers/tts-playback-session';
import { BrowserAudioSession } from '../../providers/browser-audio-session';
import type { HostedTTSPrefetchedAudio } from '../../providers/hosted-tts-prefetch';
import type { TTSPlaybackSnapshot, TTSProvider } from '../../providers/tts';
import type { TTSSleepTimerPreset } from '../../domain/types';
import { TTSActiveSleepTimer } from '../../providers/tts-sleep-timer';
import type { RemoteApiClient, RemoteProviderJob } from '../../services/remote/remote-api-client';
import { abortPrefetchControllers, releasePrefetchController } from './tts-execution-resources';

type HostedOperationLane = 'playback' | 'warmup';

export interface HostedTTSOperationToken {
  readonly lane: HostedOperationLane;
  readonly bookId: string;
  readonly chapterId: string;
  readonly controller: AbortController;
}

interface StopTTSOptions {
  readonly clearHostedState?: boolean;
  readonly updateState?: boolean;
  readonly preserveSleepTimer?: boolean;
  readonly preserveSystemPlayback?: boolean;
}

interface PollHostedTTSJobOptions {
  readonly silent?: boolean;
  readonly operation?: HostedTTSOperationToken;
}

export interface TTSExecutionControllerInput {
  readonly systemTTS: Pick<TTSProvider, 'pause' | 'resume' | 'stop'>;
  readonly audioSession?: Pick<BrowserAudioSession, 'hasActivePlayback' | 'pause' | 'playBlob' | 'resume' | 'stop'> &
    Partial<Pick<BrowserAudioSession, 'setVolume'>>;
  readonly providerClient?: RemoteApiClient;
  readonly bookId?: string;
  readonly chapterId?: string;
  readonly volume?: number;
  readonly sleepTimerPreset?: TTSSleepTimerPreset;
  readonly preserveSystemPlaybackOnUnmount?: boolean;
}

export function useTTSExecutionController(input: TTSExecutionControllerInput) {
  const [index, setIndex] = useState<number>();
  const [playing, setPlaying] = useState(false);
  const [paused, setPaused] = useState(false);
  const [activePlayback, setActivePlaybackState] = useState<ActiveTTSPlayback>();
  const [playbackJob, setPlaybackJob] = useState<RemoteProviderJob>();
  const [playbackStatus, setPlaybackStatus] = useState<string>();
  const [warmupJob, setWarmupJob] = useState<RemoteProviderJob>();
  const [warmupStatus, setWarmupStatus] = useState<string>();
  const [lastCompletedLane, setLastCompletedLane] = useState<HostedOperationLane>('playback');
  const [playbackBusy, setPlaybackBusy] = useState(false);
  const [warmupBusy, setWarmupBusy] = useState(false);
  const [sleepTimerPreset, setSleepTimerPresetState] = useState<TTSSleepTimerPreset>();
  const [sleepTimerRemainingSeconds, setSleepTimerRemainingSeconds] = useState<number>();
  const [errorMessage, setErrorMessage] = useState<string>();
  const [itemActive, setItemActiveState] = useState(false);

  const inputRef = useRef(input);
  const sessionRef = useRef(0);
  const sessionTargetRef = useRef<{ bookId: string; chapterId: string }>();
  const sessionAbortRef = useRef<AbortController>();
  const playingRef = useRef(false);
  const pausedRef = useRef(false);
  const itemActiveRef = useRef(false);
  const externalPlaybackRef = useRef(false);
  const initialTargetEstablishedRef = useRef(false);
  const resumeWaitersRef = useRef<Array<() => void>>([]);
  const playbackOperationRef = useRef<HostedTTSOperationToken>();
  const warmupOperationRef = useRef<HostedTTSOperationToken>();
  const prefetchControllersRef = useRef<Map<string, AbortController>>(new Map());
  const prefetchCacheRef = useRef(new Map<string, HostedTTSPrefetchedAudio>());
  const audioSession = useMemo(() => input.audioSession ?? new BrowserAudioSession(), [input.audioSession]);
  const sleepTimerRef = useRef(new TTSActiveSleepTimer());
  const previousTargetRef = useRef<{ bookId?: string; chapterId?: string }>({
    bookId: input.bookId,
    chapterId: input.chapterId,
  });
  inputRef.current = input;

  useEffect(() => {
    audioSession.setVolume?.(input.volume ?? 1);
  }, [audioSession, input.volume]);

  useEffect(() => {
    if (!playing) return;
    const refresh = () => setSleepTimerRemainingSeconds(sleepTimerRef.current.remainingSeconds);
    refresh();
    const interval = globalThis.setInterval(refresh, 1_000);
    return () => globalThis.clearInterval(interval);
  }, [playing]);

  const resolveResumeWaiters = useCallback(() => {
    const waiters = resumeWaitersRef.current.splice(0);
    for (const resolve of waiters) resolve();
  }, []);

  const abortPrefetch = useCallback(() => {
    abortPrefetchControllers(prefetchControllersRef.current);
    prefetchCacheRef.current.clear();
  }, []);

  const abortOperation = useCallback((lane: HostedOperationLane, updateState = true) => {
    const operationRef = lane === 'playback' ? playbackOperationRef : warmupOperationRef;
    operationRef.current?.controller.abort();
    operationRef.current = undefined;
    if (!updateState) return;
    if (lane === 'playback') setPlaybackBusy(false);
    else setWarmupBusy(false);
  }, []);

  const stopAll = useCallback(
    (options: StopTTSOptions = {}) => {
      const updateState = options.updateState !== false;
      sessionRef.current += 1;
      sessionTargetRef.current = undefined;
      sessionAbortRef.current?.abort();
      sessionAbortRef.current = undefined;
      playingRef.current = false;
      pausedRef.current = false;
      itemActiveRef.current = false;
      setItemActiveState(false);
      resolveResumeWaiters();
      if (!options.preserveSystemPlayback) inputRef.current.systemTTS.stop();
      abortOperation('playback', updateState);
      abortOperation('warmup', updateState);
      abortPrefetch();
      audioSession.stop(true);
      if (options.preserveSleepTimer) sleepTimerRef.current.pause();
      else sleepTimerRef.current.clear();
      if (!updateState) return;
      setPlaying(false);
      setPaused(false);
      setIndex(undefined);
      setActivePlaybackState(undefined);
      externalPlaybackRef.current = false;
      if (!options.preserveSleepTimer) {
        setSleepTimerPresetState(undefined);
        setSleepTimerRemainingSeconds(undefined);
        setErrorMessage(undefined);
      }
      if (options.clearHostedState !== false) {
        setPlaybackJob(undefined);
        setPlaybackStatus(undefined);
        setWarmupJob(undefined);
        setWarmupStatus(undefined);
        setLastCompletedLane('playback');
      }
    },
    [abortOperation, abortPrefetch, audioSession, resolveResumeWaiters],
  );

  useEffect(() => {
    const previous = previousTargetRef.current;
    if (input.preserveSystemPlaybackOnUnmount && !initialTargetEstablishedRef.current) {
      previousTargetRef.current = { bookId: input.bookId, chapterId: input.chapterId };
      if (input.bookId && input.chapterId) initialTargetEstablishedRef.current = true;
      return;
    }
    initialTargetEstablishedRef.current = true;
    const preserveSleepTimer = Boolean(
      previous.bookId && previous.bookId === input.bookId && previous.chapterId !== input.chapterId,
    );
    previousTargetRef.current = { bookId: input.bookId, chapterId: input.chapterId };
    stopAll({ preserveSleepTimer });
  }, [input.bookId, input.chapterId, input.preserveSystemPlaybackOnUnmount, stopAll]);

  useEffect(
    () => () =>
      stopAll({
        updateState: false,
        preserveSystemPlayback: inputRef.current.preserveSystemPlaybackOnUnmount,
      }),
    [stopAll],
  );

  const beginSession = useCallback(
    (bookId: string, chapterId: string, startIndex?: number, options: { preserveSleepTimer?: boolean } = {}) => {
      if (inputRef.current.bookId !== bookId || inputRef.current.chapterId !== chapterId) return;
      sessionRef.current += 1;
      const sessionId = sessionRef.current;
      sessionTargetRef.current = { bookId, chapterId };
      sessionAbortRef.current?.abort();
      sessionAbortRef.current = new AbortController();
      playingRef.current = true;
      externalPlaybackRef.current = false;
      pausedRef.current = false;
      resolveResumeWaiters();
      inputRef.current.systemTTS.stop();
      abortOperation('playback');
      abortPrefetch();
      audioSession.stop(true);
      if (options.preserveSleepTimer && sleepTimerRef.current.activePreset !== undefined) {
        sleepTimerRef.current.resume();
      } else {
        sleepTimerRef.current.start(inputRef.current.sleepTimerPreset);
      }
      sleepTimerRef.current.pause();
      setPlaying(true);
      setPaused(false);
      setIndex(startIndex);
      setActivePlaybackState(undefined);
      setErrorMessage(undefined);
      setSleepTimerPresetState(sleepTimerRef.current.activePreset);
      setSleepTimerRemainingSeconds(sleepTimerRef.current.remainingSeconds);
      return sessionId;
    },
    [abortOperation, abortPrefetch, audioSession, resolveResumeWaiters],
  );

  const isSessionCurrent = useCallback((sessionId: number, requirePlaying = true) => {
    const target = sessionTargetRef.current;
    return Boolean(
      target &&
      sessionId === sessionRef.current &&
      target.bookId === inputRef.current.bookId &&
      target.chapterId === inputRef.current.chapterId &&
      (!requirePlaying || playingRef.current),
    );
  }, []);

  const waitForResume = useCallback(
    async (sessionId: number): Promise<boolean> => {
      if (!pausedRef.current) return isSessionCurrent(sessionId);
      await new Promise<void>((resolve) => resumeWaitersRef.current.push(resolve));
      return isSessionCurrent(sessionId) && !pausedRef.current;
    },
    [isSessionCurrent],
  );

  const sessionSignal = useCallback(
    (sessionId: number) => (isSessionCurrent(sessionId, false) ? sessionAbortRef.current?.signal : undefined),
    [isSessionCurrent],
  );

  const setParagraph = useCallback(
    (sessionId: number, paragraphIndex: number) => {
      if (!isSessionCurrent(sessionId)) return false;
      playingRef.current = true;
      setPlaying(true);
      setIndex(paragraphIndex);
      return true;
    },
    [isSessionCurrent],
  );

  const setActivePlayback = useCallback(
    (sessionId: number, playback: ActiveTTSPlayback | undefined) => {
      if (!isSessionCurrent(sessionId)) return false;
      setActivePlaybackState(playback);
      return true;
    },
    [isSessionCurrent],
  );

  const finishSession = useCallback(
    (
      sessionId: number,
      options: {
        preserveSleepTimer?: boolean;
        preserveIndex?: boolean;
        errorMessage?: string;
      } = {},
    ) => {
      if (!isSessionCurrent(sessionId, false)) return false;
      sessionRef.current += 1;
      sessionTargetRef.current = undefined;
      sessionAbortRef.current?.abort();
      sessionAbortRef.current = undefined;
      playingRef.current = false;
      pausedRef.current = false;
      itemActiveRef.current = false;
      setItemActiveState(false);
      resolveResumeWaiters();
      abortOperation('playback');
      abortPrefetch();
      audioSession.stop(true);
      if (options.preserveSleepTimer) sleepTimerRef.current.pause();
      else sleepTimerRef.current.clear();
      setPlaying(false);
      setPaused(false);
      if (!options.preserveIndex) setIndex(undefined);
      setActivePlaybackState(undefined);
      setErrorMessage(options.errorMessage);
      if (!options.preserveSleepTimer) {
        setSleepTimerPresetState(undefined);
        setSleepTimerRemainingSeconds(undefined);
      }
      return true;
    },
    [abortOperation, abortPrefetch, audioSession, isSessionCurrent, resolveResumeWaiters],
  );

  const pause = useCallback(() => {
    if (!playingRef.current) return;
    pausedRef.current = true;
    inputRef.current.systemTTS.pause();
    audioSession.pause();
    sleepTimerRef.current.pause();
    setPaused(true);
  }, [audioSession]);

  const resume = useCallback(() => {
    if (!playingRef.current) return;
    const sessionId = sessionRef.current;
    pausedRef.current = false;
    if (itemActiveRef.current) sleepTimerRef.current.resume();
    resolveResumeWaiters();
    if (audioSession.hasActivePlayback) {
      void audioSession.resume().then((resumed) => {
        if (!resumed && isSessionCurrent(sessionId) && audioSession.hasActivePlayback) audioSession.stop(false);
      });
    } else inputRef.current.systemTTS.resume();
    setPaused(false);
  }, [audioSession, isSessionCurrent, resolveResumeWaiters]);

  const playAudio = useCallback(
    async (blob: Blob, sessionId: number): Promise<boolean> => {
      if (!isSessionCurrent(sessionId)) return true;
      if (!(await waitForResume(sessionId))) return true;
      itemActiveRef.current = true;
      setItemActiveState(true);
      if (!pausedRef.current) sleepTimerRef.current.resume();
      try {
        return await audioSession.playBlob(blob);
      } finally {
        itemActiveRef.current = false;
        setItemActiveState(false);
        sleepTimerRef.current.pause();
        setSleepTimerRemainingSeconds(sleepTimerRef.current.remainingSeconds);
      }
    },
    [audioSession, isSessionCurrent, waitForResume],
  );

  const setSleepTimer = useCallback((preset?: TTSSleepTimerPreset) => {
    sleepTimerRef.current.start(preset);
    if (pausedRef.current) sleepTimerRef.current.pause();
    setSleepTimerPresetState(preset);
    setSleepTimerRemainingSeconds(sleepTimerRef.current.remainingSeconds);
  }, []);

  const setItemActive = useCallback(
    (sessionId: number, active: boolean) => {
      if (!isSessionCurrent(sessionId, false)) return false;
      itemActiveRef.current = active;
      setItemActiveState(active);
      if (active && !pausedRef.current) sleepTimerRef.current.resume();
      else sleepTimerRef.current.pause();
      setSleepTimerRemainingSeconds(sleepTimerRef.current.remainingSeconds);
      return true;
    },
    [isSessionCurrent],
  );

  const syncExternalPlayback = useCallback((snapshot: TTSPlaybackSnapshot | undefined) => {
    if (!snapshot?.active) {
      if (!externalPlaybackRef.current) return;
      externalPlaybackRef.current = false;
      sessionTargetRef.current = undefined;
      playingRef.current = false;
      pausedRef.current = false;
      itemActiveRef.current = false;
      setPlaying(false);
      setPaused(false);
      setItemActiveState(false);
      setIndex(undefined);
      setActivePlaybackState(undefined);
      return;
    }
    if (playingRef.current && !externalPlaybackRef.current) return;
    externalPlaybackRef.current = true;
    if (inputRef.current.bookId && inputRef.current.chapterId) {
      sessionTargetRef.current = {
        bookId: inputRef.current.bookId,
        chapterId: inputRef.current.chapterId,
      };
    }
    playingRef.current = true;
    pausedRef.current = snapshot.paused;
    itemActiveRef.current = true;
    setPlaying(true);
    setPaused(snapshot.paused);
    setItemActiveState(true);
    setIndex(snapshot.anchor?.kind === 'reflowable_text' ? snapshot.anchor.blockIndex : snapshot.itemIndex);
  }, []);

  const beginOperation = useCallback(
    (
      lane: HostedOperationLane,
      bookId: string,
      chapterId: string,
      status?: string,
    ): HostedTTSOperationToken | undefined => {
      if (inputRef.current.bookId !== bookId || inputRef.current.chapterId !== chapterId) return;
      const operationRef = lane === 'playback' ? playbackOperationRef : warmupOperationRef;
      if (lane === 'warmup' && operationRef.current) return;
      if (lane === 'playback') abortOperation('playback');
      const token: HostedTTSOperationToken = {
        lane,
        bookId,
        chapterId,
        controller: new AbortController(),
      };
      operationRef.current = token;
      if (lane === 'playback') {
        setPlaybackBusy(true);
        setPlaybackJob(undefined);
        setPlaybackStatus(status);
      } else {
        setWarmupBusy(true);
        setWarmupJob(undefined);
        setWarmupStatus(status);
      }
      return token;
    },
    [abortOperation],
  );

  const operationIsCurrent = useCallback((token: HostedTTSOperationToken) => {
    const operationRef = token.lane === 'playback' ? playbackOperationRef : warmupOperationRef;
    return (
      operationRef.current === token &&
      !token.controller.signal.aborted &&
      token.bookId === inputRef.current.bookId &&
      token.chapterId === inputRef.current.chapterId
    );
  }, []);

  const finishOperation = useCallback(
    (token: HostedTTSOperationToken) => {
      if (!operationIsCurrent(token)) return false;
      const operationRef = token.lane === 'playback' ? playbackOperationRef : warmupOperationRef;
      operationRef.current = undefined;
      setLastCompletedLane(token.lane);
      if (token.lane === 'playback') setPlaybackBusy(false);
      else setWarmupBusy(false);
      return true;
    },
    [operationIsCurrent],
  );

  const setHostedJob = useCallback(
    (token: HostedTTSOperationToken, job: RemoteProviderJob | undefined) => {
      if (!operationIsCurrent(token)) return false;
      if (token.lane === 'playback') setPlaybackJob(job);
      else setWarmupJob(job);
      return true;
    },
    [operationIsCurrent],
  );

  const setHostedStatus = useCallback(
    (token: HostedTTSOperationToken, status: string | undefined) => {
      if (!operationIsCurrent(token)) return false;
      if (token.lane === 'playback') setPlaybackStatus(status);
      else setWarmupStatus(status);
      return true;
    },
    [operationIsCurrent],
  );

  const pollHostedJob = useCallback(
    async (jobId: string, signal: AbortSignal, options: PollHostedTTSJobOptions = {}) => {
      const client = inputRef.current.providerClient;
      if (!client) throw new Error('Server provider client is not available');
      const { pollTTSProviderJob } = await import('./tts-provider-job-poller');
      const operation = options.operation;
      return pollTTSProviderJob({
        jobId,
        signal,
        getJob: async (id, requestSignal) => (await client.getProviderJob(id, requestSignal)).job,
        onProgress:
          !options.silent && operation
            ? (job) => {
                if (!setHostedJob(operation, job)) return false;
                return setHostedStatus(operation, job.stage ?? job.status);
              }
            : undefined,
      });
    },
    [setHostedJob, setHostedStatus],
  );

  const beginPrefetch = useCallback(
    (sessionId: number, requestKey: string) => {
      if (!isSessionCurrent(sessionId)) return;
      if (prefetchCacheRef.current.has(requestKey) || prefetchControllersRef.current.has(requestKey)) return;
      const controller = new AbortController();
      prefetchControllersRef.current.set(requestKey, controller);
      return controller;
    },
    [isSessionCurrent],
  );

  const finishPrefetch = useCallback((requestKey: string, controller: AbortController) => {
    return releasePrefetchController(prefetchControllersRef.current, requestKey, controller);
  }, []);

  const rememberPrefetched = useCallback(
    (sessionId: number, requestKey: string, audio: HostedTTSPrefetchedAudio) => {
      if (!isSessionCurrent(sessionId)) return false;
      const cache = prefetchCacheRef.current;
      cache.delete(requestKey);
      cache.set(requestKey, audio);
      if (cache.size > 4) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey) cache.delete(oldestKey);
      }
      return true;
    },
    [isSessionCurrent],
  );

  const takePrefetched = useCallback((requestKey: string) => {
    const audio = prefetchCacheRef.current.get(requestKey);
    prefetchCacheRef.current.delete(requestKey);
    return audio;
  }, []);

  const visibleHostedLane: HostedOperationLane = playbackBusy ? 'playback' : warmupBusy ? 'warmup' : lastCompletedLane;

  return {
    index,
    playing,
    paused,
    activePlayback,
    errorMessage,
    sleepTimerPreset,
    sleepTimerRemainingSeconds,
    hostedJob: visibleHostedLane === 'playback' ? playbackJob : warmupJob,
    hostedStatus: visibleHostedLane === 'playback' ? playbackStatus : warmupStatus,
    hostedBusy: playbackBusy || warmupBusy,
    warmupBusy,
    beginSession,
    isSessionCurrent,
    waitForResume,
    sessionSignal,
    setParagraph,
    setActivePlayback,
    finishSession,
    pause,
    resume,
    stopAll,
    playAudio,
    setSleepTimer,
    setItemActive,
    syncExternalPlayback,
    itemActive,
    shouldStopAfterItem: () => sleepTimerRef.current.shouldStopAfterItem(),
    shouldStopAtChapterEnd: () => sleepTimerRef.current.shouldStopAtChapterEnd(),
    beginHostedPlayback: (sessionId: number, status?: string) => {
      const target = sessionTargetRef.current;
      return target && isSessionCurrent(sessionId)
        ? beginOperation('playback', target.bookId, target.chapterId, status)
        : undefined;
    },
    beginWarmup: (bookId: string, chapterId: string, status?: string) =>
      beginOperation('warmup', bookId, chapterId, status),
    cancelWarmup: () => abortOperation('warmup'),
    operationIsCurrent,
    finishOperation,
    setHostedJob,
    setHostedStatus,
    pollHostedJob,
    beginPrefetch,
    finishPrefetch,
    rememberPrefetched,
    takePrefetched,
  };
}
