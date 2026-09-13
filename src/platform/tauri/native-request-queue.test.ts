import { expect, it, vi } from 'vitest';
import { NativeRequestQueue } from './native-request-queue';
import { NativePackageExecution } from './native-package-execution';
it('keeps cover bursts below host capacity and starts foreground work before queued covers', async () => {
  const queue = new NativeRequestQueue();
  const started: string[] = [];
  const releases: (() => void)[] = [];
  const work = (id: string) =>
    queue.run(
      async () => {
        started.push(id);
        await new Promise<void>((resolve) => releases.push(resolve));
      },
      undefined,
      1,
    );
  const jobs = [work('cover1'), work('cover2'), work('cover3'), work('cover4')];
  const abort = new AbortController();
  const cancelled = queue.run(async () => {
    throw new Error('cancelled work started');
  }, abort.signal);
  const assertion = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
  abort.abort();
  jobs.push(
    queue.run(async () => {
      started.push('inspect');
    }),
  );
  await Promise.resolve();
  expect(started).toEqual(['cover1', 'cover2', 'cover3']);
  releases.splice(0).forEach((release) => release());
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(started).toEqual(['cover1', 'cover2', 'cover3', 'inspect', 'cover4']);
  releases.splice(0).forEach((release) => release());
  await Promise.all([...jobs, assertion]);
});
it('reuses the native session identity across adapter recreation instead of restarting the helper', async () => {
  const invoke = vi.fn(async () => ({ endpoint: 'http://127.0.0.1:12345' }));
  const fetch = vi.fn(async () => new Response('{}'));
  const first = new NativePackageExecution(invoke as never, fetch);
  const second = new NativePackageExecution(invoke as never, fetch);
  await first.apk.request({ action: 'list' });
  await second.mangayomi.request({ action: 'list' });
  expect(invoke.mock.calls).toHaveLength(2);
  expect(invoke.mock.calls[0]).toEqual(invoke.mock.calls[1]);
});
