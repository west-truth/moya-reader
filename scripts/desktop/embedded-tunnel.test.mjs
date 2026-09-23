import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { startCloudflareSharing } from './embedded-tunnel.mjs';

async function withinFiveSeconds(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('network probe timed out')), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

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

test('withdraws a live tunnel after repeated public network failures without stopping the library', async (t) => {
  const profileDir = await mkdtemp(path.join(tmpdir(), 'moya-tunnel-network-'));
  const api = createServer((request, response) => {
    if (request.url === '/api/auth/status') return response.end(JSON.stringify({ setupRequired: false }));
    response.end('library is available');
  });
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  const localUrl = `http://127.0.0.1:${api.address().port}`;
  let sharing;
  let child;
  t.after(async () => {
    await sharing?.stop();
    await new Promise((resolve) => api.close(resolve));
    await rm(profileDir, { recursive: true, force: true });
  });
  let exitNotice;
  const exited = new Promise((resolve) => {
    exitNotice = resolve;
  });
  let probes = 0;
  sharing = await startCloudflareSharing({
    url: localUrl,
    executable: process.execPath,
    profileDir,
    probePublicUrl: async () => {
      probes += 1;
      return false;
    },
    probeIntervalMs: 10,
    onExit: exitNotice,
    spawnConnector: () => {
      child = new EventEmitter();
      child.stderr = Readable.from(['https://example.trycloudflare.com\nRegistered tunnel connection\n']);
      child.exitCode = null;
      child.signalCode = null;
      child.kill = () => {
        child.signalCode = 'SIGTERM';
        queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
      };
      return child;
    },
  });
  assert.equal(sharing.url, 'https://example.trycloudflare.com');
  assert.match(await withinFiveSeconds(exited), /네트워크 연결을 확인할 수 없습니다/);
  assert.equal(probes, 3);
  assert.equal(child.signalCode, 'SIGTERM');
  assert.equal((await fetch(`${localUrl}/api/books`)).status, 200);
});
