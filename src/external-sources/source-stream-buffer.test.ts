import { describe, it, expect, vi } from 'vitest';
import { SourceStreamBuffer } from './source-stream-buffer';
function fixture() {
  const sessions: { close: ReturnType<typeof vi.fn>; loadPage: ReturnType<typeof vi.fn> }[] = [];
  const port = {
    open: vi.fn(async () => {
      const session = { pageCount: 20, close: vi.fn(), loadPage: vi.fn(async () => new Blob(['page'])) };
      sessions.push(session);
      return session;
    }),
  };
  return { port, sessions, buffer: new SourceStreamBuffer(port), signal: new AbortController().signal };
}
describe('stream episode buffer', () => {
  it('reuses the prepared next session and bytes when it becomes the current episode', async () => {
    const f = fixture();
    const first = await f.buffer.open('first', f.signal);
    const next = await f.buffer.open('next', f.signal);
    const blob = await next.loadPage(0, f.signal);
    expect(await f.buffer.open('next', f.signal)).toBe(next);
    expect(await next.loadPage(0, f.signal)).toBe(blob);
    expect(f.sessions[1].loadPage).toHaveBeenCalledTimes(1);
    f.buffer.retain(['next']);
    expect(f.sessions[0].close).toHaveBeenCalledOnce();
    await expect(first.loadPage(0, f.signal)).rejects.toThrow();
    f.buffer.close();
    expect(f.sessions[1].close).toHaveBeenCalledOnce();
  });
  it('bounds cached pages and does not retain a whole episode', async () => {
    const f = fixture(),
      session = await f.buffer.open('book', f.signal);
    for (let i = 0; i < 20; i++) await session.loadPage(i, f.signal);
    await session.loadPage(19, f.signal);
    expect(f.sessions[0].loadPage).toHaveBeenCalledTimes(20);
    await session.loadPage(0, f.signal);
    expect(f.sessions[0].loadPage).toHaveBeenCalledTimes(21);
    f.buffer.close();
  });
  it('renews expired connections transparently and retries the requested page', async () => {
    const f = fixture(),
      session = await f.buffer.open('book', f.signal);
    f.sessions[0].loadPage.mockRejectedValueOnce(new Error('source_stream_expired'));
    expect((await session.loadPage(4, f.signal)).size).toBe(4);
    expect(f.port.open).toHaveBeenCalledTimes(2);
    expect(f.sessions[0].close).toHaveBeenCalledOnce();
    expect(f.sessions[1].loadPage).toHaveBeenCalledWith(4, expect.any(AbortSignal));
    f.buffer.close();
  });
  it('closes an opening session if cancellation arrives before it resolves', async () => {
    const f = fixture(),
      controller = new AbortController();
    const pending = f.buffer.open('book', controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(f.sessions[0].close).toHaveBeenCalledOnce();
    f.buffer.close();
  });
});
