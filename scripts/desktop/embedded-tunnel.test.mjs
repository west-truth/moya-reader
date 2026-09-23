import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { startCloudflareSharing } from './embedded-tunnel.mjs';

test('does not publish a tunnel that exits immediately after its readiness log', async (t) => {
  const profileDir = await mkdtemp(path.join(tmpdir(), 'moya-tunnel-race-'));
  const fixture = path.join(profileDir, 'connector.mjs');
  await writeFile(
    fixture,
    `process.stderr.write('https://example.trycloudflare.com\\nRegistered tunnel connection\\n', () => process.exit(0));`,
  );
  const previous = process.env.NODE_OPTIONS;
  // Node preload provides a portable child-process fixture without any public tunnel.
  process.env.NODE_OPTIONS = `--import=${pathToFileURL(fixture).href}`;
  const api = createServer((_request, response) => response.end(JSON.stringify({ setupRequired: false })));
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  let sharing;
  t.after(async () => {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
    await sharing?.stop();
    await new Promise((resolve) => api.close(resolve));
    await rm(profileDir, { recursive: true, force: true });
  });
  await assert.rejects(async () => {
    sharing = await startCloudflareSharing({
      url: `http://127.0.0.1:${api.address().port}`,
      executable: process.execPath,
      profileDir,
    });
  }, /Cloudflare 연결이 종료/);
});
