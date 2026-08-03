import { useCallback, useEffect, useRef, useState } from 'react';
import type { RemoteApiClient, RemoteProviderJob } from '../../services/remote/remote-api-client';
import { AIExecutionLane, type AIExecutionToken } from './ai-execution-lane';

const DEFAULT_POLL_INTERVAL_MS = 1400;
const DEFAULT_POLL_ATTEMPTS = 180;

export interface AnalysisExecutionToken extends AIExecutionToken {
  readonly bookId: string;
  readonly chapterId?: string;
}

interface BeginAnalysisOptions {
  readonly clearJob?: boolean;
  readonly clearBundleJob?: boolean;
}

export interface AnalysisExecutionControllerInput {
  readonly client?: RemoteApiClient;
  readonly bookId?: string;
  readonly chapterId?: string;
  readonly pollIntervalMs?: number;
  readonly pollAttempts?: number;
}

interface PollRemoteProviderJobInput {
  readonly client: Pick<RemoteApiClient, 'getProviderJob'>;
  readonly jobId: string;
  readonly signal: AbortSignal;
  readonly attempts?: number;
  readonly delay?: (signal: AbortSignal) => Promise<void>;
  readonly onProgress?: (job: RemoteProviderJob) => boolean | void;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timeout = globalThis.setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        globalThis.clearTimeout(timeout);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

function targetKey(bookId: string | undefined, chapterId: string | undefined): string | undefined {
  return bookId ? `${bookId}/${chapterId ?? '-'}` : undefined;
}

export async function pollRemoteProviderJobUntilTerminal({
  client,
  jobId,
  signal,
  attempts = DEFAULT_POLL_ATTEMPTS,
  delay = (requestSignal) => abortableDelay(DEFAULT_POLL_INTERVAL_MS, requestSignal),
  onProgress,
}: PollRemoteProviderJobInput): Promise<RemoteProviderJob> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await delay(signal);
    const { job } = await client.getProviderJob(jobId, signal);
    if (onProgress?.(job) === false) throw new DOMException('Aborted', 'AbortError');
    if (job.status === 'succeeded') return job;
    if (job.status === 'failed' || job.status === 'cancelled') {
      throw new Error(job.errorMessage ?? `Provider job ${job.status}`);
    }
  }
  throw new Error('Provider job polling timed out');
}

export function useAnalysisExecutionController(input: AnalysisExecutionControllerInput) {
  const [job, setJob] = useState<RemoteProviderJob>();
  const [lastBundleJob, setLastBundleJob] = useState<RemoteProviderJob>();
  const [running, setRunning] = useState(false);
  const inputRef = useRef(input);
  const laneRef = useRef(new AIExecutionLane());
  const runningRef = useRef(false);
  inputRef.current = input;

  const reset = useCallback(() => {
    laneRef.current.invalidate();
    runningRef.current = false;
    setRunning(false);
    setJob(undefined);
    setLastBundleJob(undefined);
  }, []);

  useEffect(() => {
    const lane = laneRef.current;
    reset();
    return () => lane.invalidate();
  }, [input.bookId, input.chapterId, input.client, reset]);

  const begin = useCallback(
    (bookId: string, chapterId?: string, options: BeginAnalysisOptions = {}): AnalysisExecutionToken | undefined => {
      const current = inputRef.current;
      const currentTargetKey = targetKey(current.bookId, current.chapterId);
      if (!currentTargetKey || current.bookId !== bookId || (chapterId && current.chapterId !== chapterId)) return;
      if (runningRef.current) return;
      const token: AnalysisExecutionToken = {
        ...laneRef.current.begin(currentTargetKey),
        bookId,
        chapterId,
      };
      runningRef.current = true;
      setRunning(true);
      if (options.clearJob !== false) setJob(undefined);
      if (options.clearBundleJob) setLastBundleJob(undefined);
      return token;
    },
    [],
  );

  const isCurrent = useCallback((token: AnalysisExecutionToken) => {
    const current = inputRef.current;
    const currentTargetKey = targetKey(current.bookId, current.chapterId);
    return Boolean(currentTargetKey && laneRef.current.isCurrent(token, currentTargetKey));
  }, []);

  const publishJob = useCallback(
    (token: AnalysisExecutionToken, nextJob: RemoteProviderJob) => {
      if (!isCurrent(token) || nextJob.novelId !== token.bookId) return false;
      if (token.chapterId && nextJob.chapterId && nextJob.chapterId !== token.chapterId) return false;
      setJob(nextJob);
      return true;
    },
    [isCurrent],
  );

  const publishBundleJob = useCallback(
    (token: AnalysisExecutionToken, nextJob: RemoteProviderJob | undefined) => {
      if (!isCurrent(token) || (nextJob && nextJob.novelId !== token.bookId)) return false;
      setLastBundleJob(nextJob);
      return true;
    },
    [isCurrent],
  );

  const publishRemoteJob = useCallback(
    async (token: AnalysisExecutionToken, nextJob: RemoteProviderJob) => {
      if (publishJob(token, nextJob)) return true;
      try {
        await inputRef.current.client?.cancelProviderJob(nextJob.id);
      } catch {
        // The selection fence is authoritative; server cancellation is best effort.
      }
      return false;
    },
    [publishJob],
  );

  const pollRemoteJob = useCallback(
    (token: AnalysisExecutionToken, jobId: string): Promise<RemoteProviderJob> => {
      const client = inputRef.current.client;
      if (!client) throw new Error('Server provider client is not available');
      const intervalMs = inputRef.current.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
      return pollRemoteProviderJobUntilTerminal({
        client,
        jobId,
        signal: token.controller.signal,
        attempts: inputRef.current.pollAttempts,
        delay: (signal) => abortableDelay(intervalMs, signal),
        onProgress: (nextJob) => publishJob(token, nextJob),
      });
    },
    [publishJob],
  );

  const finish = useCallback((token: AnalysisExecutionToken) => {
    if (!laneRef.current.complete(token)) return false;
    runningRef.current = false;
    setRunning(false);
    return true;
  }, []);

  const showJob = useCallback((nextJob: RemoteProviderJob) => {
    if (nextJob.novelId !== inputRef.current.bookId) return false;
    setJob(nextJob);
    return true;
  }, []);

  return {
    job,
    lastBundleJob,
    running,
    begin,
    isCurrent,
    publishJob,
    publishRemoteJob,
    publishBundleJob,
    pollRemoteJob,
    finish,
    reset,
    showJob,
  };
}
