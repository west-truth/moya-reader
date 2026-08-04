import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright-core';

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

export async function availableLoopbackPort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error('Could not allocate a loopback port'));
        else resolvePort(port);
      });
    });
  });
}

async function waitForReachable(url, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child?.phase6StartError) throw child.phase6StartError;
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(`Vite exited before startup with code ${child.exitCode ?? child.signalCode}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([new Promise((resolveExit) => child.once('exit', resolveExit)), delay(timeoutMs)]);
}

function viteEnvironment() {
  return {
    ...process.env,
    VITE_READER_BACKEND: 'local',
    VITE_SYNC_API_BASE_URL: '',
  };
}

function captureChildOutput(child, onOutput) {
  let output = '';
  const capture = (chunk) => {
    const text = String(chunk);
    output += text;
    onOutput?.(text);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  return () => output;
}

async function runViteBuild({ rootDirectory, outDirectory, startupTimeoutMs, onOutput }) {
  const viteBin = resolve(rootDirectory, 'node_modules/vite/bin/vite.js');
  const startedAt = Date.now();
  const child = spawn(process.execPath, [viteBin, 'build', '--outDir', outDirectory, '--emptyOutDir'], {
    cwd: rootDirectory,
    env: viteEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = captureChildOutput(child, onOutput);
  const result = await Promise.race([
    new Promise((resolveResult, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolveResult({ code, signal }));
    }),
    delay(startupTimeoutMs).then(() => ({ timedOut: true })),
  ]);
  if (result.timedOut) {
    child.kill('SIGKILL');
    await waitForExit(child, 2000);
    throw new Error(`Vite production build timed out after ${startupTimeoutMs}ms`);
  }
  if (result.code !== 0) {
    throw new Error(
      `Vite production build failed with code ${result.code}${result.signal ? ` (${result.signal})` : ''}.\n${output()}`,
    );
  }
  return { buildMs: Date.now() - startedAt };
}

export async function startOwnedViteServer({ rootDirectory, startupTimeoutMs, onOutput }) {
  const port = await availableLoopbackPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const viteBin = resolve(rootDirectory, 'node_modules/vite/bin/vite.js');
  const child = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: rootDirectory,
    env: viteEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.once('error', (error) => {
    child.phase6StartError = error;
  });
  child.stdout.on('data', (chunk) => onOutput?.(String(chunk)));
  child.stderr.on('data', (chunk) => onOutput?.(String(chunk)));

  try {
    await waitForReachable(baseUrl, startupTimeoutMs, child);
  } catch (error) {
    child.kill('SIGKILL');
    await waitForExit(child, 2000);
    throw error;
  }

  return {
    baseUrl,
    owned: true,
    mode: 'development',
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      await waitForExit(child, 5000);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await waitForExit(child, 2000);
      }
      if (child.exitCode === null && child.signalCode === null) throw new Error('Owned Vite server did not exit');
    },
  };
}

export async function startOwnedVitePreviewServer({ rootDirectory, outDirectory, startupTimeoutMs, onOutput }) {
  const build = await runViteBuild({ rootDirectory, outDirectory, startupTimeoutMs, onOutput });
  const port = await availableLoopbackPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const viteBin = resolve(rootDirectory, 'node_modules/vite/bin/vite.js');
  const child = spawn(
    process.execPath,
    [viteBin, 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort', '--outDir', outDirectory],
    {
      cwd: rootDirectory,
      env: viteEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.once('error', (error) => {
    child.phase6StartError = error;
  });
  captureChildOutput(child, onOutput);

  try {
    await waitForReachable(baseUrl, startupTimeoutMs, child);
  } catch (error) {
    child.kill('SIGKILL');
    await waitForExit(child, 2000);
    throw error;
  }

  return {
    baseUrl,
    owned: true,
    mode: 'production-preview',
    buildMs: build.buildMs,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      await waitForExit(child, 5000);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await waitForExit(child, 2000);
      }
      if (child.exitCode === null && child.signalCode === null) {
        throw new Error('Owned Vite preview server did not exit');
      }
    },
  };
}

export async function useExternalServer(baseUrl, startupTimeoutMs) {
  await waitForReachable(baseUrl, startupTimeoutMs);
  return { baseUrl, owned: false, mode: 'external', stop: async () => undefined };
}

export async function launchFreshPersistentContext({ profileDirectory, explicitChannel, headed }) {
  const channels = explicitChannel ? [explicitChannel] : ['msedge', 'chrome', 'chromium'];
  const errors = [];
  for (const channel of channels) {
    await rm(profileDirectory, { recursive: true, force: true });
    try {
      const context = await chromium.launchPersistentContext(profileDirectory, {
        channel,
        headless: !headed,
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 1,
      });
      return { channel, context };
    } catch (error) {
      errors.push(`${channel}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    }
  }
  throw new Error(
    `Could not launch a Playwright-compatible Edge/Chrome browser. Set READER_UI_BROWSER_CHANNEL.\n${errors.join('\n')}`,
  );
}

export async function removeDirectoryWithRetries(directory, attempts = 6) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      return;
    } catch (error) {
      lastError = error;
      await delay(attempt * 150);
    }
  }
  throw lastError;
}
