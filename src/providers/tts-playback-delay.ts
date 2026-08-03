export async function waitForPlaybackDelay(input: {
  readonly durationMs: number;
  readonly shouldContinue: () => boolean;
  readonly waitForResume: () => Promise<boolean>;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly sleep?: (durationMs: number) => Promise<void>;
}): Promise<boolean> {
  let remaining = Math.max(0, input.durationMs);
  const now = input.now ?? (() => performance.now());
  const sleep = input.sleep ?? ((durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)));
  while (remaining > 0) {
    if (input.signal?.aborted || !input.shouldContinue() || !(await input.waitForResume())) return false;
    const slice = Math.min(remaining, 100);
    const started = now();
    await sleep(slice);
    if (input.signal?.aborted || !input.shouldContinue()) return false;
    remaining -= Math.max(0, now() - started);
  }
  return true;
}
