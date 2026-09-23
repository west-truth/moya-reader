import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { createSharingListener } from './embedded-sharing.mjs';

export function fixedTunnelOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('고정 접속 주소는 https://서재도메인 형식으로 입력해 주세요.');
  }
  return url.origin;
}

/** Only the authenticated sharing gateway is published, never the private owner API. */
export async function startCloudflareSharing({
  url,
  executable,
  profileDir,
  port,
  hostname,
  token,
  signal,
  onExit = () => {},
}) {
  signal?.throwIfAborted();
  if (!executable) throw new Error('동봉된 Cloudflare 실행 파일을 찾지 못했습니다.');
  let publicUrl = token ? fixedTunnelOrigin(hostname) : undefined;
  if (token && (typeof token !== 'string' || token.length > 8192)) throw new Error('터널 토큰을 확인해 주세요.');
  const gateway = await createSharingListener({ url, port, publicOrigin: publicUrl ?? null });
  let child;
  let closed;
  let failure;
  let connected = false;
  let active = false;
  let stopping = false;
  let stopPromise;
  const stop = () =>
    (stopPromise ??= (async () => {
      stopping = true;
      await gateway.stop();
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill();
        await closed;
      }
    })());
  try {
    const config = path.join(profileDir, 'cloudflared-app.yml');
    await writeFile(config, '{}\n', { mode: 0o600 });
    const env = { ...process.env };
    // Explicit app settings must not inherit a different system service's tunnel credentials.
    for (const key of Object.keys(env)) if (key.startsWith('TUNNEL_')) delete env[key];
    if (token) env.TUNNEL_TOKEN = token;
    const args = [
      'tunnel',
      '--config',
      config,
      '--no-autoupdate',
      '--output',
      'json',
      '--protocol',
      'http2',
      ...(token ? ['run'] : ['--url', gateway.url]),
    ];
    child = spawn(executable, args, { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    closed = new Promise((resolve) => {
      child.once('error', () => {
        failure = 'Cloudflare 실행에 실패했습니다.';
        resolve();
      });
      child.once('close', () => {
        failure ??= 'Cloudflare 연결이 종료되었습니다. 다시 연결해 주세요.';
        if (active && !stopping) {
          void gateway.stop().then(() => onExit(failure));
        }
        resolve();
      });
    });
    const lines = createInterface({ input: child.stderr });
    lines.on('line', (line) => {
      const match = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/);
      if (!token && match) publicUrl = match[0];
      if (line.includes('Registered tunnel connection')) connected = true;
    });
    const deadline = Date.now() + 60_000;
    while (!publicUrl || !connected) {
      signal?.throwIfAborted();
      if (failure) throw new Error(failure);
      if (Date.now() >= deadline)
        throw new Error('Cloudflare 연결 시간이 초과되었습니다. 네트워크와 터널 설정을 확인해 주세요.');
      await delay(100, undefined, { signal });
    }
    gateway.setPublicOrigin(publicUrl);
    active = true;
    return { url: publicUrl, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
