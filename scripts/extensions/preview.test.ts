import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startDevelopmentPreview } from './preview';

const roots: string[] = [];
interface PreviewSnapshot {
  status: string;
  callId: string;
  error?: string;
  current?: { assets?: Array<{ contentType: string; byteLength: number }> };
  lastGood?: unknown;
}
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

it('serves a local fixture preview and retains the last good result after a build error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'moya-extension-preview-'));
  roots.push(root);
  await cp(resolve('packages/extension-runtime/examples/text-catalog'), root, { recursive: true });
  const preview = await startDevelopmentPreview(root, {
    method: 'source.getContent',
    input: join(root, 'content-input.json'),
    fixture: join(root, 'fixtures.json'),
  });
  try {
    expect(preview.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const page = await fetch(preview.url);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await page.text()).toContain('Local extension preview');
    const ready = await fetch(preview.stateUrl).then((response) => response.json());
    expect(ready).toMatchObject({
      status: 'ready',
      callId: 'preview-1',
      current: { method: 'source.getContent', result: { kind: 'text' } },
    });
    expect(ready.current.assets[0]).toEqual({ contentType: 'text/plain', byteLength: expect.any(Number) });

    await writeFile(join(root, 'src/index.ts'), 'export default { broken: ; };');
    const failed = await poll(preview.stateUrl, (state) => state.status === 'error');
    expect(failed.callId).toBe('preview-2');
    expect(failed.error).toContain('src/index.ts:1:');
    expect(failed.lastGood).toMatchObject({ method: 'source.getContent', result: { kind: 'text' } });
  } finally {
    await preview.close();
  }
});

async function poll(url: string, accept: (value: PreviewSnapshot) => boolean) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = (await fetch(url).then((response) => response.json())) as PreviewSnapshot;
    if (accept(value)) return value;
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 100));
  }
  throw new Error('preview_state_timeout');
}
