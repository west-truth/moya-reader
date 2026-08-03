import type { RemoteProviderJob } from '../../services/remote/remote-api-client';

const POLL_INTERVAL_MS = 1400;
const POLL_ATTEMPTS = 180;

interface PollTTSProviderJobInput {
  readonly jobId: string;
  readonly signal: AbortSignal;
  readonly getJob: (jobId: string, signal: AbortSignal) => Promise<RemoteProviderJob>;
  readonly onProgress?: (job: RemoteProviderJob) => boolean | void;
}

function delay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timeout = globalThis.setTimeout(resolve, POLL_INTERVAL_MS);
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

export async function pollTTSProviderJob({
  jobId,
  signal,
  getJob,
  onProgress,
}: PollTTSProviderJobInput): Promise<RemoteProviderJob> {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    await delay(signal);
    const job = await getJob(jobId, signal);
    if (onProgress?.(job) === false) throw new DOMException('Aborted', 'AbortError');
    if (job.status === 'succeeded') return job;
    if (job.status === 'failed' || job.status === 'cancelled') {
      throw new Error(job.errorMessage ?? `TTS provider job ${job.status}`);
    }
  }
  throw new Error('TTS provider job polling timed out');
}
